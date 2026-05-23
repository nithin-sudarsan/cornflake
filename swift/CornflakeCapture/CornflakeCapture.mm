// CornflakeCapture.mm
// N-API addon: system audio via CoreAudio Process Tap (macOS 14.2+),
// mic via AVAudioEngine. Both streams output as 16 kHz mono 16-bit PCM WAV
// temp files.
//
// Exported:
//   startCapture(cb: (err: string|null) => void): void
//   stopCapture (cb: (err: string|null, result: {micPath,systemAudioPath}|null) => void): void
//
// System audio capture uses Apple's CoreAudio Process Tap API:
//   1. CATapDescription describes the tap (all system audio output)
//   2. AudioHardwareCreateProcessTap creates the tap
//   3. AudioHardwareCreateAggregateDevice wraps the tap into a virtual input
//   4. AVAudioEngine reads PCM from the aggregate device
//
// This avoids ScreenCaptureKit entirely. macOS surfaces this in System
// Settings → Privacy & Security → "System Audio Recording Only" (different
// TCC service from Screen Recording — kTCCServiceAudioCapture).
//
// Info.plist must include: NSAudioCaptureUsageDescription

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>  // NSWorkspace, for finding the WhatsApp PID
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>  // third-tier SCK audio fallback
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AudioToolbox/AudioToolbox.h>
#include <napi.h>
#include <string>
#include <atomic>
#include <mutex>
#include <cstdio>
#include <cstdint>
#include <unistd.h>

// ─── WAV helpers ─────────────────────────────────────────────────────────────

static constexpr uint32_t kSampleRate = 16000;
static constexpr uint16_t kChannels   = 1;

static inline int16_t f32ToI16(float v) {
    if (v >  1.0f) v =  1.0f;
    if (v < -1.0f) v = -1.0f;
    return static_cast<int16_t>(v * 32767.0f);
}

static void writeWavHeader(FILE* f, uint32_t numSamples) {
    uint32_t dataSize   = numSamples * kChannels * 2;
    uint32_t chunkSize  = 36 + dataSize;
    uint16_t audioFmt   = 1;
    uint32_t byteRate   = kSampleRate * kChannels * 2;
    uint16_t blockAlign = kChannels * 2;
    uint16_t bitsPerSample = 16;
    uint32_t fmtSize    = 16;

    fseek(f, 0, SEEK_SET);
    fwrite("RIFF",          1, 4, f); fwrite(&chunkSize,    4, 1, f);
    fwrite("WAVE",          1, 4, f);
    fwrite("fmt ",          1, 4, f); fwrite(&fmtSize,      4, 1, f);
    fwrite(&audioFmt,       2, 1, f);
    uint16_t ch = kChannels;
    fwrite(&ch,             2, 1, f);
    uint32_t sr = kSampleRate;
    fwrite(&sr,             4, 1, f); fwrite(&byteRate,     4, 1, f);
    fwrite(&blockAlign,     2, 1, f); fwrite(&bitsPerSample,2, 1, f);
    fwrite("data",          1, 4, f); fwrite(&dataSize,     4, 1, f);
}

struct PcmFile {
    FILE*    fp         = nullptr;
    uint32_t numSamples = 0;
    std::mutex mtx;

    bool open(const std::string& path) {
        std::lock_guard<std::mutex> lk(mtx);
        fp = fopen(path.c_str(), "wb");
        if (!fp) return false;
        uint8_t hdr[44] = {};
        fwrite(hdr, 1, 44, fp);
        numSamples = 0;
        return true;
    }

    void writeSamples(const float* buf, size_t n) {
        std::lock_guard<std::mutex> lk(mtx);
        if (!fp) return;
        for (size_t i = 0; i < n; ++i) {
            int16_t s = f32ToI16(buf[i]);
            fwrite(&s, 2, 1, fp);
        }
        numSamples += static_cast<uint32_t>(n);
    }

    void finalise() {
        std::lock_guard<std::mutex> lk(mtx);
        if (!fp) return;
        writeWavHeader(fp, numSamples);
        fclose(fp);
        fp = nullptr;
    }
};

// ─── Global capture state ────────────────────────────────────────────────────

static AVAudioEngine* g_micEngine = nil;
static AVAudioEngine* g_sysEngine = nil;
static AudioObjectID  g_tapID       = kAudioObjectUnknown;
static AudioObjectID  g_aggregateID = kAudioObjectUnknown;
static std::atomic<bool>         g_capturing { false };
static std::string               g_sysPath;
static std::string               g_micPath;
static PcmFile                   g_sysFile;
static PcmFile                   g_micFile;

// Mutex serialising every mutation of the sys-side tap/aggregate/engine state
// (setup, teardown, and the default-output-change rebuild). Without it,
// StopCapture could destroy the aggregate while the rebuild is in the middle
// of recreating it. Recursive so a single thread can re-enter (the rebuild
// path calls helpers that also lock).
static std::recursive_mutex g_sysAudioMutex;

// Serial dispatch queue for the default-output-change rebuild. The CoreAudio
// listener callback hops onto this queue so the actual rebuild work does NOT
// run on a CoreAudio thread (which would be dangerous) and so multiple rapid
// changes coalesce into ordered, non-overlapping rebuilds.
static dispatch_queue_t g_sysAudioRebuildQueue = nullptr;

// True when AudioObjectAddPropertyListener has been installed for the default
// output device. Installed inside StartCapture once setup succeeds; removed in
// StopCapture / startup-failure cleanup.
static std::atomic<bool> g_defaultOutputListenerInstalled { false };

// ── WhatsApp VoIP silence-fallback state ─────────────────────────────────────
//
// WhatsApp's VoIP path bypasses the system audio mixer, so the global tap
// (initStereoGlobalTapButExcludeProcesses) captures silence even though a
// call is clearly producing audio. If we observe >=5s of buffer-level silence
// during an active capture we attempt to rebuild the tap using
// initWithProcesses: targeting WhatsApp specifically. The global-tap path
// remains the primary; this is one-shot fallback for the WhatsApp scenario.
//
// kSilenceEpsilon — max |sample| we still consider "silence" (1e-4 ≈ -80 dBFS).
// kSilenceThresholdSamples — 5 seconds at 16 kHz mono.
static constexpr float    kSilenceEpsilon            = 0.0001f;
static constexpr uint64_t kSilenceThresholdSamples   = 5 * (uint64_t)kSampleRate;

// Running count of consecutive silent samples seen in the sys tap-on-bus
// block. Reset to 0 whenever a buffer has any signal above kSilenceEpsilon.
static std::atomic<uint64_t> g_silentSamplesAccum { 0 };

// One-shot guard so we attempt the WhatsApp fallback only once per active
// tap. Reset on capture start and on default-output-change rebuilds (a fresh
// global tap deserves a fresh chance before we conclude it's silent).
static std::atomic<bool> g_whatsappFallbackAttempted { false };

// One-shot guard for the third-tier ScreenCaptureKit (SCStream) fallback.
// Fires if the WhatsApp process tap is *also* silent for 5 consecutive
// seconds. This is a completely different capture path — ScreenCaptureKit
// instead of CATapDescription — so the SCK side can produce signal even
// when both tap variants stay silent. RMS from SCK buffers is logged on a
// separate stderr line so the two paths can be compared.
static std::atomic<bool> g_sckFallbackAttempted { false };

static const NSString* kWhatsAppBundleId = @"net.whatsapp.WhatsApp";

// ── SCK fallback state ───────────────────────────────────────────────────────
@class CornflakeSCKDelegate;
static SCStream*              g_sckStream         = nil;
static CornflakeSCKDelegate*  g_sckDelegate       = nil;
static dispatch_queue_t       g_sckAudioQueue     = nullptr;
static dispatch_queue_t       g_sckVideoQueue     = nullptr;
static std::atomic<bool>      g_sckActive { false };
static std::atomic<uint64_t>  g_sckBufferCount    { 0 };
// When SCK becomes the active audio source, it writes its samples directly
// to g_sysFile and the tap-on-bus path stops writing (otherwise silent
// zeros from the tap would shred the real signal). Counters are for the
// "bytes written from SCK path" confirmation log.
static std::atomic<uint64_t>  g_sckSamplesWritten { 0 };
static std::atomic<bool>      g_sckFirstWriteLogged { false };

static std::string g_startError;
static std::string g_stopError;
static std::string g_stopSysPath;
static std::string g_stopMicPath;

static Napi::ThreadSafeFunction g_startTsfn;
static Napi::ThreadSafeFunction g_stopTsfn;
static std::atomic<bool>        g_startTsfnLive { false };
static std::atomic<bool>        g_stopTsfnLive  { false };

static std::string nsStringToStd(NSString* s) {
    return s ? std::string([s UTF8String]) : std::string("");
}

// ─── TSFN call-JS callbacks ──────────────────────────────────────────────────

static void OnStartCallJs(Napi::Env env, Napi::Function jsCb, void* /*data*/) {
    if (g_startError.empty()) {
        jsCb.Call({ env.Null() });
    } else {
        jsCb.Call({ Napi::String::New(env, g_startError) });
    }
}

static void OnStopCallJs(Napi::Env env, Napi::Function jsCb, void* /*data*/) {
    if (!g_stopError.empty()) {
        jsCb.Call({ Napi::String::New(env, g_stopError), env.Null() });
    } else {
        Napi::Object res = Napi::Object::New(env);
        res.Set("systemAudioPath", Napi::String::New(env, g_stopSysPath));
        res.Set("micPath",         Napi::String::New(env, g_stopMicPath));
        jsCb.Call({ env.Null(), res });
    }
}

static void fireStart(const std::string& err) {
    if (!g_startTsfnLive.exchange(false)) return;
    g_startError = err;
    g_startTsfn.BlockingCall(static_cast<void*>(nullptr), OnStartCallJs);
    g_startTsfn.Release();
}

static void fireStop(const std::string& err, const std::string& sys, const std::string& mic) {
    if (!g_stopTsfnLive.exchange(false)) return;
    g_stopError   = err;
    g_stopSysPath = sys;
    g_stopMicPath = mic;
    g_stopTsfn.BlockingCall(static_cast<void*>(nullptr), OnStopCallJs);
    g_stopTsfn.Release();
}

// ─── Process tap helpers (macOS 14.2+) ───────────────────────────────────────

// Fetch the tap's CFString UID via the AudioObject property API.
API_AVAILABLE(macos(14.2))
static NSString* tapUIDString(AudioObjectID tapID) {
    CFStringRef uidRef = NULL;
    UInt32 size = sizeof(uidRef);
    AudioObjectPropertyAddress addr = {
        .mSelector = kAudioTapPropertyUID,
        .mScope    = kAudioObjectPropertyScopeGlobal,
        .mElement  = kAudioObjectPropertyElementMain,
    };
    OSStatus err = AudioObjectGetPropertyData(tapID, &addr, 0, NULL, &size, &uidRef);
    if (err != noErr || !uidRef) return nil;
    return (__bridge_transfer NSString*)uidRef;
}

// Returns the UID string of the system's current default OUTPUT device
// (i.e. the speakers / headphones the user is hearing audio through).
// The aggregate device needs this as its main sub-device so the process tap
// has a real audio stream to mirror — without it, the tap produces silence.
static NSString* defaultOutputDeviceUID() {
    AudioObjectID outDev = kAudioObjectUnknown;
    UInt32 size = sizeof(outDev);
    AudioObjectPropertyAddress devAddr = {
        .mSelector = kAudioHardwarePropertyDefaultOutputDevice,
        .mScope    = kAudioObjectPropertyScopeGlobal,
        .mElement  = kAudioObjectPropertyElementMain,
    };
    OSStatus err = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &devAddr, 0, NULL, &size, &outDev);
    if (err != noErr || outDev == kAudioObjectUnknown) {
        NSLog(@"[CornflakeCapture] defaultOutputDevice lookup failed: %d", (int)err);
        return nil;
    }

    CFStringRef uidRef = NULL;
    size = sizeof(uidRef);
    AudioObjectPropertyAddress uidAddr = {
        .mSelector = kAudioDevicePropertyDeviceUID,
        .mScope    = kAudioObjectPropertyScopeGlobal,
        .mElement  = kAudioObjectPropertyElementMain,
    };
    err = AudioObjectGetPropertyData(outDev, &uidAddr, 0, NULL, &size, &uidRef);
    if (err != noErr || !uidRef) {
        NSLog(@"[CornflakeCapture] defaultOutputDevice UID lookup failed: %d", (int)err);
        return nil;
    }
    return (__bridge_transfer NSString*)uidRef;
}

// Wrap the existing g_tapID in an aggregate device bound to the system's
// current default output. Extracted from setupSystemAudioTap so both the
// global tap and the WhatsApp-process tap fallback can reuse the same
// aggregate logic. On failure: destroys the tap and clears g_tapID.
API_AVAILABLE(macos(14.2))
static OSStatus wrapTapInAggregate(std::string& errOut) {
    NSString* tapUID = tapUIDString(g_tapID);
    if (!tapUID) {
        NSLog(@"[CornflakeCapture] Tap UID lookup failed");
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
        errOut = "AUDIO_TAP_UID_FAILED";
        return -1;
    }
    NSLog(@"[CornflakeCapture] Tap UID: %@", tapUID);

    NSString* aggUID = [NSString stringWithFormat:@"app.cornflake.mac.aggregate.%@",
                        [[NSUUID UUID] UUIDString]];

    // The aggregate device needs a real audio device as its "main" sub-device
    // for the process tap to have an audio stream to mirror. We use whatever
    // the user is currently hearing audio through (default output). Without
    // this, the tap delivers buffers full of zeros — silent but non-empty.
    NSString* mainOutputUID = defaultOutputDeviceUID();
    if (!mainOutputUID) {
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
        errOut = "AUDIO_DEFAULT_OUTPUT_LOOKUP_FAILED";
        return -1;
    }
    NSLog(@"[CornflakeCapture] Default output device UID: %@", mainOutputUID);

    NSDictionary* aggDict = @{
        @kAudioAggregateDeviceNameKey:            @"Cornflake Aggregate",
        @kAudioAggregateDeviceUIDKey:             aggUID,
        @kAudioAggregateDeviceMainSubDeviceKey:   mainOutputUID,
        @kAudioAggregateDeviceIsPrivateKey:       @YES,
        @kAudioAggregateDeviceIsStackedKey:       @NO,
        @kAudioAggregateDeviceTapAutoStartKey:    @YES,
        @kAudioAggregateDeviceTapListKey: @[
            @{
                @kAudioSubTapUIDKey:                 tapUID,
                @kAudioSubTapDriftCompensationKey:   @YES,
            }
        ],
    };

    OSStatus err = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggDict, &g_aggregateID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioHardwareCreateAggregateDevice failed: %d", (int)err);
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
        errOut = "AUDIO_AGGREGATE_CREATE_FAILED:" + std::to_string((int)err);
        return err;
    }
    NSLog(@"[CornflakeCapture] Created aggregate device ID=%u", g_aggregateID);
    return noErr;
}

// Create the process tap + aggregate device wrapper. Returns 0 on success and
// writes the failure reason to errOut on failure. This is the GLOBAL tap path
// that captures every process's output via the system mixer — left intact.
API_AVAILABLE(macos(14.2))
static OSStatus setupSystemAudioTap(std::string& errOut) {
    // initStereoGlobalTapButExcludeProcesses:@[] explicitly means "tap all
    // system audio, exclude no processes". Empty processes on the
    // initStereoMixdownOfProcesses: variant is API-ambiguous — some macOS
    // releases interpret it as "tap nothing" and produce silent captures.
    // The global-tap variant is unambiguously "everything".
    CATapDescription* desc =
        [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
    desc.UUID         = [NSUUID UUID];
    desc.name         = @"Cornflake System Audio";
    desc.privateTap   = YES;
    desc.muteBehavior = CATapUnmuted;

    NSLog(@"[CornflakeCapture] CATapDescription: UUID=%@ name=%@ processes=%@ "
          @"exclusive=%d mono=%d mixdown=%d privateTap=%d muteBehavior=%ld",
          desc.UUID, desc.name, desc.processes,
          desc.exclusive, desc.mono, desc.mixdown,
          desc.privateTap, (long)desc.muteBehavior);

    OSStatus err = AudioHardwareCreateProcessTap(desc, &g_tapID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioHardwareCreateProcessTap failed: %d", (int)err);
        errOut = "AUDIO_TAP_CREATE_FAILED:" + std::to_string((int)err);
        return err;
    }
    NSLog(@"[CornflakeCapture] Created process tap (global), ID=%u", g_tapID);

    return wrapTapInAggregate(errOut);
}

// WhatsApp VoIP fallback path: build a tap that targets a single process
// audio-object explicitly (initWithProcesses:), then wrap it in the same
// aggregate as the global path. Used only when the global tap has been
// silent for >=5s. The global setupSystemAudioTap remains the default; this
// is invoked from tryWhatsAppFallback().
API_AVAILABLE(macos(14.2))
static OSStatus setupSystemAudioTapForProcessObject(AudioObjectID procObjID, std::string& errOut) {
    // initStereoMixdownOfProcesses: mixes down ONLY the listed processes.
    // The empty-array form is ambiguous on some OS versions and yields
    // silence (hence the comment on the global path), but the non-empty
    // form used here is well-defined: "tap exactly these processes".
    CATapDescription* desc =
        [[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(procObjID)]];
    desc.UUID         = [NSUUID UUID];
    desc.name         = @"Cornflake System Audio (WhatsApp)";
    desc.privateTap   = YES;
    desc.muteBehavior = CATapUnmuted;

    NSLog(@"[CornflakeCapture] CATapDescription (process-specific): UUID=%@ name=%@ "
          @"processes=%@ exclusive=%d mono=%d mixdown=%d privateTap=%d muteBehavior=%ld",
          desc.UUID, desc.name, desc.processes,
          desc.exclusive, desc.mono, desc.mixdown,
          desc.privateTap, (long)desc.muteBehavior);

    OSStatus err = AudioHardwareCreateProcessTap(desc, &g_tapID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioHardwareCreateProcessTap (process) failed: %d", (int)err);
        errOut = "AUDIO_TAP_CREATE_FAILED:" + std::to_string((int)err);
        return err;
    }
    NSLog(@"[CornflakeCapture] Created process tap (WhatsApp), ID=%u", g_tapID);

    return wrapTapInAggregate(errOut);
}

// Forward declarations — the tap-on-bus block created inside
// startSystemAudioEngine schedules these on the rebuild queue when it
// detects sustained silence. Defined below alongside the other rebuild
// helpers.
API_AVAILABLE(macos(14.2))
static void tryWhatsAppFallback();
API_AVAILABLE(macos(13.0))
static void trySckFallback();

// Build the AVAudioEngine that mirrors the aggregate device, install the
// tap-on-bus block that converts to 16 kHz mono and writes WAV, and start
// the engine. Assumes setupSystemAudioTap() has already populated g_tapID +
// g_aggregateID. Called from StartCapture and from the default-output-change
// rebuild path; the rebuild path discards the previous engine first.
API_AVAILABLE(macos(14.2))
static OSStatus startSystemAudioEngine(AVAudioFormat* targetFmt, std::string& errOut) {
    g_sysEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* sysIn = g_sysEngine.inputNode;

    AudioUnit sysAU = [sysIn audioUnit];
    AudioDeviceID devID = g_aggregateID;
    OSStatus setDevErr = AudioUnitSetProperty(sysAU,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0,
        &devID, sizeof(devID));
    if (setDevErr != noErr) {
        NSLog(@"[CornflakeCapture] Failed to set input device on sys AU: %d", (int)setDevErr);
        errOut = "AUDIO_SET_DEVICE_FAILED:" + std::to_string((int)setDevErr);
        return setDevErr;
    }

    AVAudioFormat* sysHwFmt = [sysIn outputFormatForBus:0];
    NSLog(@"[CornflakeCapture] System audio hardware format: %@", sysHwFmt);

    __block AVAudioConverter* sysConverter =
        [[AVAudioConverter alloc] initFromFormat:sysHwFmt toFormat:targetFmt];

    __block uint64_t sysCallbackCount  = 0;
    __block uint64_t sysSamplesWritten = 0;
    __block double   sysPeakAbs        = 0.0;
    __block uint64_t sysLastLogCount   = 0;

    [sysIn installTapOnBus:0 bufferSize:4096 format:sysHwFmt
                     block:^(AVAudioPCMBuffer* hwBuf, AVAudioTime*) {
        if (!g_capturing.load()) return;

        sysCallbackCount++;

        double ratio = targetFmt.sampleRate / sysHwFmt.sampleRate;
        AVAudioFrameCount outFrames =
            static_cast<AVAudioFrameCount>(ceil(hwBuf.frameLength * ratio)) + 8;
        AVAudioPCMBuffer* outBuf =
            [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFmt frameCapacity:outFrames];

        __block BOOL inputConsumed = NO;
        NSError* cvtErr = nil;
        [sysConverter convertToBuffer:outBuf error:&cvtErr
             withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount /*n*/,
                                                 AVAudioConverterInputStatus* status) {
                 if (!inputConsumed) {
                     *status = AVAudioConverterInputStatus_HaveData;
                     inputConsumed = YES;
                     return hwBuf;
                 }
                 *status = AVAudioConverterInputStatus_NoDataNow;
                 return nil;
             }];

        if (!cvtErr && outBuf.frameLength > 0 && outBuf.floatChannelData) {
            const float* samples = outBuf.floatChannelData[0];
            AVAudioFrameCount n = outBuf.frameLength;
            float bufferPeak = 0.0f;
            for (AVAudioFrameCount i = 0; i < n; ++i) {
                float a = fabsf(samples[i]);
                if (a > sysPeakAbs)  sysPeakAbs  = a;
                if (a > bufferPeak)  bufferPeak  = a;
            }
            // Hand the tap output to the WAV only while SCK is NOT the active
            // source. When SCK takes over, the tap is producing silent zeros
            // (that's how we got here) — writing them on top of real SCK
            // samples would interleave silence into the file. Silence
            // detection still runs below so we can keep logging.
            if (!g_sckActive.load()) {
                g_sysFile.writeSamples(samples, n);
                sysSamplesWritten += n;
            }

            // Cascading silence-fallback: accumulate consecutive silent
            // samples. When the 5s threshold is crossed, schedule the next
            // un-attempted fallback in order: (1) WhatsApp process tap, then
            // (2) ScreenCaptureKit. The accumulator is reset on scheduling so
            // the next tier gets its own 5s window to prove itself. The
            // global tap path stays primary; tiers fire only on silence.
            if (bufferPeak < kSilenceEpsilon) {
                uint64_t prev = g_silentSamplesAccum.fetch_add(n);
                if (prev + n >= kSilenceThresholdSamples) {
                    if (!g_whatsappFallbackAttempted.exchange(true)) {
                        g_silentSamplesAccum.store(0);
                        fprintf(stderr,
                            "[CornflakeCapture][debug] >=5s of silence detected — "
                            "scheduling WhatsApp tap fallback (silentSamples=%llu)\n",
                            (unsigned long long)(prev + n));
                        fflush(stderr);
                        if (g_sysAudioRebuildQueue) {
                            dispatch_async(g_sysAudioRebuildQueue, ^{
                                if (@available(macOS 14.2, *)) {
                                    tryWhatsAppFallback();
                                }
                            });
                        }
                    } else if (!g_sckFallbackAttempted.exchange(true)) {
                        g_silentSamplesAccum.store(0);
                        fprintf(stderr,
                            "[CornflakeCapture][debug] >=5s of silence persists after "
                            "WhatsApp fallback — scheduling SCK fallback "
                            "(silentSamples=%llu)\n",
                            (unsigned long long)(prev + n));
                        fflush(stderr);
                        if (g_sysAudioRebuildQueue) {
                            dispatch_async(g_sysAudioRebuildQueue, ^{
                                if (@available(macOS 13.0, *)) {
                                    trySckFallback();
                                }
                            });
                        }
                    }
                }
            } else {
                g_silentSamplesAccum.store(0);
            }

            // DEBUG: RMS of every 100th buffer — silent ≈ 0.0000, music ≈ 0.05+.
            // Lets us distinguish "tap is firing but silent" from "tap stopped"
            // when the default output changes mid-recording.
            if (sysCallbackCount % 100 == 0) {
                double sumSq = 0.0;
                for (AVAudioFrameCount i = 0; i < n; ++i) {
                    sumSq += (double)samples[i] * (double)samples[i];
                }
                double rms = (n > 0) ? sqrt(sumSq / (double)n) : 0.0;
                fprintf(stderr,
                    "[CornflakeCapture][debug] tap-on-bus rms #%llu frames=%u rms=%.5f\n",
                    sysCallbackCount, (unsigned)n, rms);
                fflush(stderr);
            }
        }

        if (sysCallbackCount - sysLastLogCount >= 50) {
            sysLastLogCount = sysCallbackCount;
            NSLog(@"[CornflakeCapture] sys-tap: callbacks=%llu samplesWritten=%llu peakAbs=%.4f",
                  sysCallbackCount, sysSamplesWritten, sysPeakAbs);
            sysPeakAbs = 0.0;
        }
    }];

    NSError* sysEngineErr = nil;
    [g_sysEngine startAndReturnError:&sysEngineErr];
    if (sysEngineErr) {
        NSLog(@"[CornflakeCapture] Sys AVAudioEngine error: %@", sysEngineErr.localizedDescription);
        errOut = "AUDIO_ENGINE_FAILED:" + std::string([sysEngineErr.localizedDescription UTF8String]);
        return -1;
    }
    return noErr;
}

// Tear down JUST the sys-side engine — the tap-on-bus block and the
// AVAudioEngine itself, but leave g_tapID / g_aggregateID alone. Used by the
// rebuild path before it destroys + recreates the aggregate underneath.
static void stopSystemAudioEngineOnly() {
    if (g_sysEngine) {
        @try { [g_sysEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] sys removeTap exception: %@", ex.reason);
        }
        [g_sysEngine stop];
        g_sysEngine = nil;
    }
}

API_AVAILABLE(macos(14.2))
static void teardownSystemAudioTap() {
    stopSystemAudioEngineOnly();
    if (g_aggregateID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(g_aggregateID);
        g_aggregateID = kAudioObjectUnknown;
    }
    if (g_tapID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
    }
}

// ─── Third-tier SCK fallback (capturesAudio over a display SCContentFilter) ──
//
// If even the WhatsApp process-tap produces silence (audio paths that bypass
// CoreAudio Process Tap altogether, or permission edge cases), try the
// ScreenCaptureKit audio path. This is intentionally a completely different
// capture pipeline — different framework, different TCC service (Screen
// Recording), different delegate model — so it can succeed where the tap
// chain fails. The samples are NOT written to the WAV file; we only log RMS
// so the two paths can be compared.

@interface CornflakeSCKDelegate : NSObject <SCStreamOutput, SCStreamDelegate>
@end

@implementation CornflakeSCKDelegate

// Audio (and required-but-ignored video) sample callback. SCStream invokes
// this on the queue we register per output type.
- (void)stream:(SCStream *)stream
  didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                 ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) return;
    if (!g_sckActive.load()) return;
    if (!sampleBuffer || !CMSampleBufferIsValid(sampleBuffer)) return;

    // Pull an AudioBufferList referencing the sample data. The block buffer
    // returned must be released after we're done reading.
    AudioBufferList abl;
    memset(&abl, 0, sizeof(abl));
    CMBlockBufferRef blockBuf = NULL;
    OSStatus err = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        NULL,
        &abl, sizeof(abl),
        kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        &blockBuf);

    if (err != noErr || abl.mNumberBuffers == 0) {
        if (blockBuf) CFRelease(blockBuf);
        return;
    }

    // SCStreamConfiguration with capturesAudio=YES delivers Float32 LPCM.
    // Compute the per-buffer RMS across whichever channel(s) are present —
    // for the comparison we only care about "any signal at all".
    double sumSq = 0.0;
    uint64_t totalSamples = 0;
    for (UInt32 b = 0; b < abl.mNumberBuffers; ++b) {
        const float* data = (const float*)abl.mBuffers[b].mData;
        UInt32 byteSize   = abl.mBuffers[b].mDataByteSize;
        UInt32 nFloats    = byteSize / sizeof(float);
        if (!data) continue;
        for (UInt32 i = 0; i < nFloats; ++i) {
            sumSq += (double)data[i] * (double)data[i];
        }
        totalSamples += nFloats;
    }
    double rms = (totalSamples > 0) ? sqrt(sumSq / (double)totalSamples) : 0.0;

    uint64_t count = ++g_sckBufferCount;
    // Log every 100th SCK buffer so this line lines up cadence-wise with the
    // tap-on-bus RMS log and the two can be compared at a glance.
    if (count % 100 == 0) {
        fprintf(stderr,
            "[CornflakeCapture][debug] sck-audio rms #%llu frames=%llu rms=%.5f\n",
            (unsigned long long)count,
            (unsigned long long)totalSamples,
            rms);
        fflush(stderr);
    }

    // Write SCK samples to the sys WAV. The stream is configured to deliver
    // 16 kHz mono Float32 (kSampleRate, kChannels) — exactly the WAV's target
    // format — so no resampling/conversion is needed before handing the
    // buffer to PcmFile::writeSamples (which is what the tap-on-bus block
    // also uses, including the Float32→int16 step).
    //
    // For non-interleaved mono there will be exactly one mBuffer; we take it
    // as-is. Defensive against an unexpected layout: log once and skip.
    if (g_capturing.load() && abl.mNumberBuffers >= 1) {
        const float* samples = (const float*)abl.mBuffers[0].mData;
        UInt32 byteSize      = abl.mBuffers[0].mDataByteSize;
        UInt32 nFloats       = byteSize / sizeof(float);
        if (samples && nFloats > 0) {
            // Confirm the format on the first sample so we have a record in
            // logs that the SCK path is feeding our WAV with sane data.
            if (!g_sckFirstWriteLogged.exchange(true)) {
                CMAudioFormatDescriptionRef fmt =
                    (CMAudioFormatDescriptionRef)CMSampleBufferGetFormatDescription(sampleBuffer);
                const AudioStreamBasicDescription* asbd =
                    fmt ? CMAudioFormatDescriptionGetStreamBasicDescription(fmt) : NULL;
                if (asbd) {
                    fprintf(stderr,
                        "[CornflakeCapture][debug] sck-audio FIRST WRITE — "
                        "rate=%g channels=%u bitsPerChannel=%u flags=0x%x "
                        "buffers=%u frames=%u bytes=%u\n",
                        asbd->mSampleRate,
                        (unsigned)asbd->mChannelsPerFrame,
                        (unsigned)asbd->mBitsPerChannel,
                        (unsigned)asbd->mFormatFlags,
                        (unsigned)abl.mNumberBuffers,
                        (unsigned)nFloats,
                        (unsigned)byteSize);
                } else {
                    fprintf(stderr,
                        "[CornflakeCapture][debug] sck-audio FIRST WRITE — "
                        "buffers=%u frames=%u bytes=%u (no ASBD)\n",
                        (unsigned)abl.mNumberBuffers,
                        (unsigned)nFloats,
                        (unsigned)byteSize);
                }
                fflush(stderr);
            }

            g_sysFile.writeSamples(samples, nFloats);
            uint64_t total = g_sckSamplesWritten.fetch_add(nFloats) + nFloats;

            // Periodic confirmation log — same cadence as the RMS line so the
            // two are easy to correlate in the terminal.
            if (count % 100 == 0) {
                fprintf(stderr,
                    "[CornflakeCapture][debug] sck-audio wrote frames=%u to sys WAV "
                    "(cumulative samples=%llu, bytes=%llu)\n",
                    (unsigned)nFloats,
                    (unsigned long long)total,
                    (unsigned long long)(total * sizeof(int16_t)));
                fflush(stderr);
            }
        }
    }

    CFRelease(blockBuf);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    NSLog(@"[CornflakeCapture] SCK stream stopped: %@",
          error ? error.localizedDescription : @"(no error)");
    g_sckActive.store(false);
}

@end

// Tear down whatever SCK stream is running, if any. Safe to call from the
// rebuild queue or from StopCapture.
static void stopScKAudioCapture() {
    g_sckActive.store(false);
    SCStream* stream = g_sckStream;
    g_sckStream      = nil;
    g_sckDelegate    = nil;
    if (stream) {
        [stream stopCaptureWithCompletionHandler:^(NSError* err) {
            if (err) {
                NSLog(@"[CornflakeCapture] SCK stopCapture error: %@",
                      err.localizedDescription);
            }
        }];
    }
}

// Build + start the SCK audio stream. Asynchronous — SCShareableContent
// fetching is itself async. Logs progress so failures from missing Screen
// Recording permission are visible.
API_AVAILABLE(macos(13.0))
static void startScKAudioCapture() {
    if (!g_sckAudioQueue) {
        g_sckAudioQueue = dispatch_queue_create(
            "app.cornflake.mac.sckAudio",
            dispatch_queue_attr_make_with_qos_class(
                DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0));
    }
    if (!g_sckVideoQueue) {
        // SCStream audio callbacks only fire when a video output is also
        // registered. Background queue — we never read these buffers.
        g_sckVideoQueue = dispatch_queue_create(
            "app.cornflake.mac.sckVideo",
            dispatch_queue_attr_make_with_qos_class(
                DISPATCH_QUEUE_SERIAL, QOS_CLASS_BACKGROUND, 0));
    }

    [SCShareableContent getShareableContentWithCompletionHandler:^(
        SCShareableContent* content, NSError* getErr) {
        if (getErr || !content || content.displays.count == 0) {
            NSLog(@"[CornflakeCapture] SCK getShareableContent failed: %@",
                  getErr ? getErr.localizedDescription : @"(no displays)");
            fprintf(stderr,
                "[CornflakeCapture][debug] SCK fallback FAILED (shareable content): %s\n",
                getErr ? [getErr.localizedDescription UTF8String] : "no displays");
            fflush(stderr);
            return;
        }

        SCDisplay* mainDisplay = content.displays.firstObject;
        // Capture the main display, exclude no applications, except no windows
        // — the display-level filter is what the request specified.
        SCContentFilter* filter =
            [[SCContentFilter alloc] initWithDisplay:mainDisplay
                              excludingApplications:@[]
                                   exceptingWindows:@[]];

        SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
        config.capturesAudio = YES;
        config.sampleRate    = kSampleRate;
        config.channelCount  = kChannels;
        // Minimal video output — we don't consume it but SCK requires it for
        // audio callbacks to fire. Smallest plausible frame at 1 fps.
        config.width                  = 2;
        config.height                 = 2;
        config.minimumFrameInterval   = CMTimeMake(1, 1);
        config.queueDepth             = 5;
        config.showsCursor            = NO;

        CornflakeSCKDelegate* delegate = [[CornflakeSCKDelegate alloc] init];
        SCStream* stream =
            [[SCStream alloc] initWithFilter:filter
                               configuration:config
                                    delegate:delegate];

        NSError* outErr = nil;
        BOOL ok = [stream addStreamOutput:delegate
                                     type:SCStreamOutputTypeAudio
                       sampleHandlerQueue:g_sckAudioQueue
                                    error:&outErr];
        if (!ok) {
            NSLog(@"[CornflakeCapture] SCK addStreamOutput(audio) failed: %@",
                  outErr.localizedDescription);
            fprintf(stderr,
                "[CornflakeCapture][debug] SCK fallback FAILED (addStreamOutput audio): %s\n",
                [outErr.localizedDescription UTF8String]);
            fflush(stderr);
            return;
        }

        ok = [stream addStreamOutput:delegate
                                type:SCStreamOutputTypeScreen
                  sampleHandlerQueue:g_sckVideoQueue
                               error:&outErr];
        if (!ok) {
            NSLog(@"[CornflakeCapture] SCK addStreamOutput(screen no-op) failed: %@",
                  outErr.localizedDescription);
            // Non-fatal? Audio probably won't fire, but try start anyway and
            // log the result.
        }

        g_sckStream   = stream;
        g_sckDelegate = delegate;

        [stream startCaptureWithCompletionHandler:^(NSError* startErr) {
            if (startErr) {
                NSLog(@"[CornflakeCapture] SCK startCapture failed: %@",
                      startErr.localizedDescription);
                fprintf(stderr,
                    "[CornflakeCapture][debug] SCK fallback FAILED (start): %s\n",
                    [startErr.localizedDescription UTF8String]);
                fflush(stderr);
                g_sckStream   = nil;
                g_sckDelegate = nil;
                return;
            }
            g_sckActive.store(true);
            g_sckBufferCount.store(0);
            NSLog(@"[CornflakeCapture] SCK fallback: stream started — observe sck-audio rms logs");
            fprintf(stderr,
                "[CornflakeCapture][debug] SCK fallback COMPLETE — stream running\n");
            fflush(stderr);
        }];
    }];
}

// Entry point scheduled from the tap-on-bus silence detector. Guarded so we
// don't try to spin up multiple SCK streams.
API_AVAILABLE(macos(13.0))
static void trySckFallback() {
    if (!g_capturing.load()) {
        fprintf(stderr,
            "[CornflakeCapture][debug] SCK fallback: capture stopped, skipping\n");
        fflush(stderr);
        return;
    }
    if (g_sckActive.load() || g_sckStream != nil) {
        fprintf(stderr,
            "[CornflakeCapture][debug] SCK fallback: already active, skipping\n");
        fflush(stderr);
        return;
    }
    fprintf(stderr,
        "[CornflakeCapture][debug] SCK fallback START — bringing up parallel SCStream audio capture\n");
    fflush(stderr);
    startScKAudioCapture();
}

// ─── WhatsApp VoIP silence fallback ──────────────────────────────────────────

// Returns the running WhatsApp PID, or 0 if WhatsApp is not running. Uses
// NSWorkspace.runningApplications — no shelling out, no entitlements needed
// beyond what NSWorkspace itself requires.
static pid_t findWhatsAppPid() {
    @autoreleasepool {
        NSArray<NSRunningApplication*>* apps =
            [[NSWorkspace sharedWorkspace] runningApplications];
        for (NSRunningApplication* app in apps) {
            if ([app.bundleIdentifier isEqualToString:(NSString*)kWhatsAppBundleId]) {
                return app.processIdentifier;
            }
        }
        return 0;
    }
}

// Translate a POSIX pid_t to a CoreAudio process AudioObjectID via the system
// object's TranslatePIDToProcessObject qualifier. Returns kAudioObjectUnknown
// on failure (process has no audio object, or PID not running).
API_AVAILABLE(macos(14.2))
static AudioObjectID processObjectIDForPID(pid_t pid) {
    AudioObjectPropertyAddress addr = {
        .mSelector = kAudioHardwarePropertyTranslatePIDToProcessObject,
        .mScope    = kAudioObjectPropertyScopeGlobal,
        .mElement  = kAudioObjectPropertyElementMain,
    };
    AudioObjectID procID = kAudioObjectUnknown;
    UInt32 size = sizeof(procID);
    OSStatus err = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &addr,
        sizeof(pid), &pid,
        &size, &procID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] PID→ProcessObject translation failed for pid=%d: %d",
              (int)pid, (int)err);
        return kAudioObjectUnknown;
    }
    return procID;
}

// One-shot fallback invoked from the tap-on-bus block when >=5s of consecutive
// silence is observed. If WhatsApp is running, tear down the global tap and
// rebuild a process-specific tap targeting WhatsApp. The global path remains
// the default; this only runs once per session (gated by
// g_whatsappFallbackAttempted) — so if WhatsApp's VoIP audio also doesn't
// surface here, we simply log and leave the WhatsApp tap in place for the
// duration of the recording.
API_AVAILABLE(macos(14.2))
static void tryWhatsAppFallback() {
    std::lock_guard<std::recursive_mutex> lock(g_sysAudioMutex);

    if (!g_capturing.load()) {
        fprintf(stderr,
            "[CornflakeCapture][debug] WhatsApp fallback: capture stopped, skipping\n");
        fflush(stderr);
        return;
    }

    pid_t pid = findWhatsAppPid();
    if (pid == 0) {
        NSLog(@"[CornflakeCapture] WhatsApp fallback: WhatsApp not running, skipping");
        fprintf(stderr,
            "[CornflakeCapture][debug] WhatsApp fallback skipped — WhatsApp not running\n");
        fflush(stderr);
        return;
    }
    NSLog(@"[CornflakeCapture] WhatsApp fallback: WhatsApp PID=%d", (int)pid);

    AudioObjectID procObjID = processObjectIDForPID(pid);
    if (procObjID == kAudioObjectUnknown) {
        NSLog(@"[CornflakeCapture] WhatsApp fallback: PID→ProcessObject translation failed");
        fprintf(stderr,
            "[CornflakeCapture][debug] WhatsApp fallback skipped — translation failed\n");
        fflush(stderr);
        return;
    }
    NSLog(@"[CornflakeCapture] WhatsApp fallback: ProcessObject=%u", (unsigned)procObjID);

    fprintf(stderr,
        "[CornflakeCapture][debug] WhatsApp fallback START — rebuilding tap "
        "targeting PID=%d procObj=%u\n",
        (int)pid, (unsigned)procObjID);
    fflush(stderr);

    // Tear down the current (silent) engine + aggregate + tap.
    stopSystemAudioEngineOnly();
    if (g_aggregateID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(g_aggregateID);
        g_aggregateID = kAudioObjectUnknown;
    }
    if (g_tapID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
    }

    // Build the process-specific tap. wrapTapInAggregate handles the
    // aggregate-device construction identically to the global path.
    std::string setupErr;
    OSStatus tapStatus = setupSystemAudioTapForProcessObject(procObjID, setupErr);
    if (tapStatus != noErr) {
        NSLog(@"[CornflakeCapture] WhatsApp fallback: tap setup failed: %s",
              setupErr.c_str());
        fprintf(stderr,
            "[CornflakeCapture][debug] WhatsApp fallback FAILED (setup): %s\n",
            setupErr.c_str());
        fflush(stderr);
        return;
    }

    AVAudioFormat* targetFmt = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:kSampleRate
                    channels:kChannels
                 interleaved:NO];

    std::string engineErr;
    OSStatus engineStatus = startSystemAudioEngine(targetFmt, engineErr);
    if (engineStatus != noErr) {
        NSLog(@"[CornflakeCapture] WhatsApp fallback: engine restart failed: %s",
              engineErr.c_str());
        fprintf(stderr,
            "[CornflakeCapture][debug] WhatsApp fallback FAILED (engine): %s\n",
            engineErr.c_str());
        fflush(stderr);
        return;
    }

    // Reset the silence accumulator so the new tap is observed cleanly. The
    // RMS-every-100-buffers log line will tell us whether targeting WhatsApp
    // changed anything.
    g_silentSamplesAccum.store(0);

    NSLog(@"[CornflakeCapture] WhatsApp fallback: complete — watch upcoming RMS to verify");
    fprintf(stderr,
        "[CornflakeCapture][debug] WhatsApp fallback COMPLETE — tapID=%u aggregateID=%u\n",
        (unsigned)g_tapID, (unsigned)g_aggregateID);
    fflush(stderr);
}

// ─── Default-output-device change listener ───────────────────────────────────
//
// The aggregate device's main sub-device is captured once at StartCapture
// time. If the user (or an app like WhatsApp / Google Meet) switches the
// system default output mid-call, the aggregate stays bound to the old
// device and the tap mirrors silence. We listen for that change and
// rebuild aggregate + tap against the new default output. The tap
// description and stream/conversion configuration are NOT changed — only
// the underlying audio object graph is rotated.

static const AudioObjectPropertyAddress kDefaultOutputDeviceAddress = {
    .mSelector = kAudioHardwarePropertyDefaultOutputDevice,
    .mScope    = kAudioObjectPropertyScopeGlobal,
    .mElement  = kAudioObjectPropertyElementMain,
};

API_AVAILABLE(macos(14.2))
static void rebuildSysAudioForNewDefaultOutput() {
    fprintf(stderr,
        "[CornflakeCapture][debug] rebuildSysAudioForNewDefaultOutput START\n");
    fflush(stderr);

    std::lock_guard<std::recursive_mutex> lock(g_sysAudioMutex);

    // The capture may have been stopped between the listener firing and this
    // rebuild reaching the front of the serial queue. If so, do nothing — the
    // teardown path has already cleaned up.
    if (!g_capturing.load()) {
        NSLog(@"[CornflakeCapture] default-output-change: capture stopped, skipping rebuild");
        fprintf(stderr,
            "[CornflakeCapture][debug] rebuildSysAudioForNewDefaultOutput SKIP (not capturing)\n");
        fflush(stderr);
        return;
    }

    NSLog(@"[CornflakeCapture] default output device changed — rebuilding aggregate + tap");

    // Stop the engine first so its AudioUnit releases its reference to the
    // current aggregate device. Without this, destroying the aggregate while
    // an engine is mirroring it can yield kAudioHardwareNotRunningError noise.
    stopSystemAudioEngineOnly();

    if (g_aggregateID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(g_aggregateID);
        g_aggregateID = kAudioObjectUnknown;
    }
    if (g_tapID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
    }

    // Recreate the tap + aggregate. setupSystemAudioTap re-reads the default
    // output device UID, so the new aggregate is bound to the new default.
    std::string err;
    OSStatus tapStatus = setupSystemAudioTap(err);
    if (tapStatus != noErr) {
        NSLog(@"[CornflakeCapture] default-output-change: setupSystemAudioTap failed: %s",
              err.c_str());
        return;
    }

    // Rebuild the engine pointing at the new aggregate. The conversion target
    // format is the same constant (16 kHz mono Float32) used at first start.
    AVAudioFormat* targetFmt = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:kSampleRate
                    channels:kChannels
                 interleaved:NO];

    std::string engineErr;
    OSStatus engineStatus = startSystemAudioEngine(targetFmt, engineErr);
    if (engineStatus != noErr) {
        NSLog(@"[CornflakeCapture] default-output-change: startSystemAudioEngine failed: %s",
              engineErr.c_str());
        return;
    }

    // Give the freshly-rebuilt global tap a clean 5s window to prove it can
    // produce signal before we'd consider falling back to the WhatsApp path.
    // (SCK fallback state intentionally NOT reset here — if SCK is already
    // running because the previous global tap was silent, we don't want to
    // re-attempt it just because the default output changed.)
    g_silentSamplesAccum.store(0);
    g_whatsappFallbackAttempted.store(false);

    NSLog(@"[CornflakeCapture] default-output-change: rebuild complete");
    fprintf(stderr,
        "[CornflakeCapture][debug] rebuildSysAudioForNewDefaultOutput COMPLETE — tapID=%u aggregateID=%u\n",
        (unsigned)g_tapID, (unsigned)g_aggregateID);
    fflush(stderr);
}

API_AVAILABLE(macos(14.2))
static OSStatus defaultOutputPropertyListener(
    AudioObjectID /*inObjectID*/,
    UInt32 /*inNumberAddresses*/,
    const AudioObjectPropertyAddress* /*inAddresses*/,
    void* /*inClientData*/)
{
    // DEBUG: log on the CoreAudio thread so we see the fire event even if the
    // serial queue is busy. Read the new default output UID right here too —
    // it should already reflect the change by the time the listener runs.
    NSString* newUID = defaultOutputDeviceUID();
    fprintf(stderr,
        "[CornflakeCapture][debug] defaultOutputPropertyListener fired — newDefaultOutputUID=%s\n",
        newUID ? [newUID UTF8String] : "(nil)");
    fflush(stderr);

    // CoreAudio invokes this on its own thread; hop to the serial queue so
    // the rebuild runs off the CoreAudio thread and rapid back-to-back
    // changes serialise into one rebuild at a time.
    if (g_sysAudioRebuildQueue) {
        dispatch_async(g_sysAudioRebuildQueue, ^{
            if (@available(macOS 14.2, *)) {
                rebuildSysAudioForNewDefaultOutput();
            }
        });
    }
    return noErr;
}

API_AVAILABLE(macos(14.2))
static void installDefaultOutputListener() {
    if (g_defaultOutputListenerInstalled.load()) return;
    if (!g_sysAudioRebuildQueue) {
        g_sysAudioRebuildQueue = dispatch_queue_create(
            "app.cornflake.mac.sysAudioRebuild", DISPATCH_QUEUE_SERIAL);
    }
    OSStatus err = AudioObjectAddPropertyListener(
        kAudioObjectSystemObject,
        &kDefaultOutputDeviceAddress,
        defaultOutputPropertyListener,
        nullptr);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioObjectAddPropertyListener failed: %d", (int)err);
        return;
    }
    g_defaultOutputListenerInstalled.store(true);
    NSLog(@"[CornflakeCapture] default-output-device listener installed");
}

API_AVAILABLE(macos(14.2))
static void removeDefaultOutputListener() {
    if (!g_defaultOutputListenerInstalled.exchange(false)) return;
    OSStatus err = AudioObjectRemovePropertyListener(
        kAudioObjectSystemObject,
        &kDefaultOutputDeviceAddress,
        defaultOutputPropertyListener,
        nullptr);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioObjectRemovePropertyListener failed: %d", (int)err);
    } else {
        NSLog(@"[CornflakeCapture] default-output-device listener removed");
    }
}

static void cleanupAfterStartFailure() {
    if (g_micEngine) {
        @try { [g_micEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] mic removeTap exception: %@", ex.reason);
        }
        [g_micEngine stop];
        g_micEngine = nil;
    }
    if (@available(macOS 14.2, *)) {
        removeDefaultOutputListener();
        teardownSystemAudioTap();
    }
    // Tear down the SCK fallback stream if it ever started — independent of
    // the tap chain.
    stopScKAudioCapture();
    g_capturing.store(false);
    g_micFile.finalise();
    g_sysFile.finalise();
}

// ─── startCapture ────────────────────────────────────────────────────────────

static Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "startCapture(callback) expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_capturing.load()) {
        Napi::Error::New(env, "Already capturing").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NSString* tmp  = NSTemporaryDirectory();
    NSString* uuid = [[NSUUID UUID] UUIDString];
    g_sysPath = [[tmp stringByAppendingPathComponent:
                  [NSString stringWithFormat:@"cf_sys_%@.wav", uuid]] UTF8String];
    g_micPath = [[tmp stringByAppendingPathComponent:
                  [NSString stringWithFormat:@"cf_mic_%@.wav", uuid]] UTF8String];

    if (!g_sysFile.open(g_sysPath) || !g_micFile.open(g_micPath)) {
        Napi::Error::New(env, "Failed to create temp audio files").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_startTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "startCapture", 0, 1);
    g_startTsfnLive.store(true);

    // ── Mic: AVAudioEngine ────────────────────────────────────────────────────
    g_micEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* micIn = g_micEngine.inputNode;
    AVAudioFormat* micHwFmt = [micIn outputFormatForBus:0];
    NSLog(@"[CornflakeCapture] Mic hardware format: %@", micHwFmt);

    AVAudioFormat* targetFmt = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:kSampleRate
                    channels:kChannels
                 interleaved:NO];

    __block AVAudioConverter* micConverter =
        [[AVAudioConverter alloc] initFromFormat:micHwFmt toFormat:targetFmt];

    [micIn installTapOnBus:0 bufferSize:4096 format:micHwFmt
                     block:^(AVAudioPCMBuffer* hwBuf, AVAudioTime*) {
        if (!g_capturing.load()) return;

        double ratio = targetFmt.sampleRate / micHwFmt.sampleRate;
        AVAudioFrameCount outFrames =
            static_cast<AVAudioFrameCount>(ceil(hwBuf.frameLength * ratio)) + 8;
        AVAudioPCMBuffer* outBuf =
            [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFmt frameCapacity:outFrames];

        __block BOOL inputConsumed = NO;
        NSError* cvtErr = nil;
        [micConverter convertToBuffer:outBuf error:&cvtErr
             withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount /*n*/,
                                                 AVAudioConverterInputStatus* status) {
                 if (!inputConsumed) {
                     *status = AVAudioConverterInputStatus_HaveData;
                     inputConsumed = YES;
                     return hwBuf;
                 }
                 *status = AVAudioConverterInputStatus_NoDataNow;
                 return nil;
             }];

        if (!cvtErr && outBuf.frameLength > 0 && outBuf.floatChannelData)
            g_micFile.writeSamples(outBuf.floatChannelData[0], outBuf.frameLength);
    }];

    NSError* micEngineErr = nil;
    [g_micEngine startAndReturnError:&micEngineErr];
    if (micEngineErr) {
        NSLog(@"[CornflakeCapture] Mic AVAudioEngine error: %@", micEngineErr.localizedDescription);
        // Non-fatal — JS handles mic permission separately.
    }

    // ── System audio: CoreAudio Process Tap ──────────────────────────────────
    if (@available(macOS 14.2, *)) {
        std::lock_guard<std::recursive_mutex> lock(g_sysAudioMutex);

        // Reset the silence/fallback state for this new capture session.
        g_silentSamplesAccum.store(0);
        g_whatsappFallbackAttempted.store(false);
        g_sckFallbackAttempted.store(false);
        g_sckBufferCount.store(0);
        g_sckSamplesWritten.store(0);
        g_sckFirstWriteLogged.store(false);

        std::string tapErr;
        OSStatus tapStatus = setupSystemAudioTap(tapErr);
        if (tapStatus != noErr) {
            cleanupAfterStartFailure();
            fireStart(tapErr);
            return env.Undefined();
        }

        std::string engineErr;
        OSStatus engineStatus = startSystemAudioEngine(targetFmt, engineErr);
        if (engineStatus != noErr) {
            cleanupAfterStartFailure();
            fireStart(engineErr);
            return env.Undefined();
        }

        g_capturing.store(true);

        // Watch for default-output-device changes so the aggregate doesn't get
        // stranded on a stale device (e.g. WhatsApp swapping the output at
        // call start). Installed after success so failures during setup don't
        // leave a dangling listener.
        installDefaultOutputListener();

        fireStart("");  // success
    } else {
        cleanupAfterStartFailure();
        fireStart("macOS 14.2 or later is required for system audio capture");
    }

    return env.Undefined();
}

// ─── stopCapture ─────────────────────────────────────────────────────────────

static Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "stopCapture(callback) expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (!g_capturing.load()) {
        Napi::Error::New(env, "Not capturing").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_stopTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "stopCapture", 0, 1);
    g_stopTsfnLive.store(true);

    // Remove the default-output listener BEFORE setting g_capturing=false so
    // any callback already queued on the rebuild serial queue will, when it
    // runs, see g_capturing == false and bail out instead of racing teardown.
    if (@available(macOS 14.2, *)) {
        removeDefaultOutputListener();
    }

    g_capturing.store(false);

    // Stop mic
    if (g_micEngine) {
        @try { [g_micEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] stop: mic removeTap exception: %@", ex.reason);
        }
        [g_micEngine stop];
        g_micEngine = nil;
    }
    g_micFile.finalise();

    // Stop system audio
    if (@available(macOS 14.2, *)) {
        std::lock_guard<std::recursive_mutex> lock(g_sysAudioMutex);
        teardownSystemAudioTap();
    }
    // Stop the SCK fallback stream too. Independent of the tap teardown.
    stopScKAudioCapture();
    g_sysFile.finalise();

    fireStop("", g_sysPath, g_micPath);
    return env.Undefined();
}

// ─── Mic-input PID enumeration ───────────────────────────────────────────────
//
// Returns the POSIX PIDs of every audio process that currently has input
// running (i.e. is actively reading from the microphone). Built on top of
// CoreAudio's kAudioHardwarePropertyProcessObjectList +
// kAudioProcessPropertyIsRunningInput, which were introduced in macOS 14.2.
//
// Used by the meeting-app watcher to detect browser-based meetings (Google
// Meet, Zoom Web) that don't show up in the native-app process list.

static Napi::Array GetMicInputPIDs(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);

    if (@available(macOS 14.2, *)) {
        // Fetch the size of the process-object list, then read it.
        AudioObjectPropertyAddress listAddr = {
            .mSelector = kAudioHardwarePropertyProcessObjectList,
            .mScope    = kAudioObjectPropertyScopeGlobal,
            .mElement  = kAudioObjectPropertyElementMain,
        };
        UInt32 listSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &listAddr, 0, NULL, &listSize);
        if (err != noErr || listSize == 0) return result;

        std::vector<AudioObjectID> procObjs(listSize / sizeof(AudioObjectID));
        err = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &listAddr,
            0, NULL, &listSize, procObjs.data());
        if (err != noErr) return result;

        uint32_t outIdx = 0;
        for (AudioObjectID procObj : procObjs) {
            // Is this process actively reading from an input device?
            AudioObjectPropertyAddress runAddr = {
                .mSelector = kAudioProcessPropertyIsRunningInput,
                .mScope    = kAudioObjectPropertyScopeGlobal,
                .mElement  = kAudioObjectPropertyElementMain,
            };
            UInt32 isRunning = 0;
            UInt32 size = sizeof(isRunning);
            err = AudioObjectGetPropertyData(procObj, &runAddr,
                                             0, NULL, &size, &isRunning);
            if (err != noErr || isRunning == 0) continue;

            // Translate the audio process object back to a POSIX PID.
            AudioObjectPropertyAddress pidAddr = {
                .mSelector = kAudioProcessPropertyPID,
                .mScope    = kAudioObjectPropertyScopeGlobal,
                .mElement  = kAudioObjectPropertyElementMain,
            };
            pid_t pid = 0;
            size = sizeof(pid);
            err = AudioObjectGetPropertyData(procObj, &pidAddr,
                                             0, NULL, &size, &pid);
            if (err != noErr || pid <= 0) continue;

            result.Set(outIdx++, Napi::Number::New(env, (double)pid));
        }
    }

    return result;
}

// ─── Module init ─────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture",     Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",      Napi::Function::New(env, StopCapture));
    exports.Set("getMicInputPIDs",  Napi::Function::New(env, GetMicInputPIDs));
    return exports;
}

NODE_API_MODULE(cornflake_capture, Init)
