#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static NSWindow *permissionWindow;

static BOOL hasArgument(int argc, char *argv[], const char *argument) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], argument) == 0) { return YES; }
    }
    return NO;
}

static void requestNordbasePermissions(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

    NSRect frame = NSMakeRect(0, 0, 460, 170);
    permissionWindow = [[NSWindow alloc] initWithContentRect:frame
                                                   styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    [permissionWindow center];
    [permissionWindow setTitle:@"Nordbase Agent"];

    NSTextField *title = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 98, 412, 28)];
    [title setStringValue:@"Nordbase Agent"];
    [title setFont:[NSFont boldSystemFontOfSize:20]];
    [title setBezeled:NO];
    [title setDrawsBackground:NO];
    [title setEditable:NO];
    [title setSelectable:NO];

    NSTextField *body = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 42, 412, 52)];
    [body setStringValue:@"macOS will ask for remote support permissions. Approve Nordbase Agent in Privacy & Security."];
    [body setFont:[NSFont systemFontOfSize:13]];
    [body setBezeled:NO];
    [body setDrawsBackground:NO];
    [body setEditable:NO];
    [body setSelectable:NO];
    [body setLineBreakMode:NSLineBreakByWordWrapping];

    [[permissionWindow contentView] addSubview:title];
    [[permissionWindow contentView] addSubview:body];
    [permissionWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, true);

    NSDictionary *accessibilityOptions = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)accessibilityOptions);

    if (@available(macOS 10.15, *)) {
        CGPreflightScreenCaptureAccess();
        CGRequestScreenCaptureAccess();
        CGRequestPostEventAccess();
    }

    if (@available(macOS 12.3, *)) {
        __block BOOL screenCaptureProbeDone = NO;
        [SCShareableContent getShareableContentWithCompletionHandler:^(
            SCShareableContent *shareableContent,
            NSError *error
        ) {
            (void)shareableContent;
            (void)error;
            screenCaptureProbeDone = YES;
            CFRunLoopStop(CFRunLoopGetMain());
        }];

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
        while (!screenCaptureProbeDone && [deadline timeIntervalSinceNow] > 0) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, true);
        }
    } else {
        CGImageRef permissionProbeImage = CGWindowListCreateImage(
            CGRectInfinite,
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            kCGWindowImageDefault
        );
        if (permissionProbeImage != NULL) { CGImageRelease(permissionProbeImage); }
    }

    CGImageRef displayProbeImage = CGDisplayCreateImage(CGMainDisplayID());
    if (displayProbeImage != NULL) { CGImageRelease(displayProbeImage); }

    CGImageRef windowProbeImage = CGWindowListCreateImage(
        CGRectInfinite,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageDefault
    );
    if (windowProbeImage != NULL) { CGImageRelease(windowProbeImage); }

    CGDirectDisplayID displayId = CGMainDisplayID();
    CGDisplayStreamRef displayStream = CGDisplayStreamCreate(
        displayId,
        CGDisplayPixelsWide(displayId),
        CGDisplayPixelsHigh(displayId),
        'BGRA',
        NULL,
        ^(
            CGDisplayStreamFrameStatus status,
            uint64_t displayTime,
            IOSurfaceRef frameSurface,
            CGDisplayStreamUpdateRef updateRef
        ) {
            (void)status;
            (void)displayTime;
            (void)frameSurface;
            (void)updateRef;
        }
    );
    if (displayStream != NULL) {
        CGDisplayStreamStart(displayStream);
        NSDate *streamDeadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([streamDeadline timeIntervalSinceNow] > 0) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, true);
        }
        CGDisplayStreamStop(displayStream);
        CFRelease(displayStream);
    }
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        BOOL permissionOnly = hasArgument(argc, argv, "--nordbase-permissions") || (getuid() != 0);
        if (permissionOnly) {
            requestNordbasePermissions();
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
            while ([deadline timeIntervalSinceNow] > 0) {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, true);
            }
            return 0;
        }

        char executablePath[PATH_MAX];
        uint32_t executablePathSize = sizeof(executablePath);
        if (_NSGetExecutablePath(executablePath, &executablePathSize) != 0) { return 70; }

        char resolvedPath[PATH_MAX];
        if (realpath(executablePath, resolvedPath) == NULL) { return 71; }

        char runtimeDirectory[PATH_MAX];
        if (getcwd(runtimeDirectory, sizeof(runtimeDirectory)) != NULL) {
            char cwdCoreName[PATH_MAX];
            snprintf(cwdCoreName, sizeof(cwdCoreName), "%s/NordbaseAgentCore", runtimeDirectory);
            if (access(cwdCoreName, X_OK) != 0) {
                snprintf(runtimeDirectory, sizeof(runtimeDirectory), "%s", "/usr/local/mesh_services/nordbase/nordbaseagent");
            }
        } else {
            snprintf(runtimeDirectory, sizeof(runtimeDirectory), "%s", "/usr/local/mesh_services/nordbase/nordbaseagent");
        }

        char runtimeCoreName[PATH_MAX];
        snprintf(runtimeCoreName, sizeof(runtimeCoreName), "%s/NordbaseAgentCore", runtimeDirectory);

        char *executableDirectory = dirname(resolvedPath);
        char bundledCoreName[PATH_MAX];
        snprintf(bundledCoreName, sizeof(bundledCoreName), "%s/NordbaseAgentCore", executableDirectory);

        char corePath[PATH_MAX];
        if (access(runtimeCoreName, X_OK) == 0) {
            snprintf(corePath, sizeof(corePath), "%s", runtimeCoreName);
        } else {
            snprintf(corePath, sizeof(corePath), "%s", bundledCoreName);
        }

        char **coreArgv = calloc((size_t)argc + 1, sizeof(char *));
        if (coreArgv == NULL) { return 72; }
        coreArgv[0] = corePath;
        for (int i = 1; i < argc; i++) { coreArgv[i] = argv[i]; }
        coreArgv[argc] = NULL;

        pid_t childPid;
        int spawnResult = posix_spawn(&childPid, corePath, NULL, NULL, coreArgv, environ);
        if (spawnResult != 0) { return 73; }

        int childStatus = 0;
        if (waitpid(childPid, &childStatus, 0) < 0) { return 74; }
        if (WIFEXITED(childStatus)) { return WEXITSTATUS(childStatus); }
        if (WIFSIGNALED(childStatus)) { return 128 + WTERMSIG(childStatus); }
        return 75;
    }
}
