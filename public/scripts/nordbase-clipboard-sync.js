(function (root, factory) {
    var api = factory();
    if ((typeof module == 'object') && (module.exports != null)) { module.exports = api; }
    if (root != null) { root.NordbaseClipboard = api; }
}(typeof globalThis == 'object' ? globalThis : this, function () {
    'use strict';

    // Nordbase support page clipboard rules (security review part 2, 11 November 2026):
    //  - Nothing is ever synchronised automatically, in either direction.
    //  - Text moves only when the operator presses "Pull from device" or "Push to device".
    //  - Only the window that has focus may do it, and only with a connected desktop session,
    //    an open clipboard channel and a share that has not expired.
    var AUTOMATIC_SYNC = false;

    function manualClipboardAllowed(input) {
        return input != null &&
            input.hasFocus === true &&
            input.hidden !== true &&
            input.expired !== true &&
            input.desktopConnected === true &&
            input.channelReady === true;
    }

    // A clipboard answer from the device is only used when the operator asked for it.
    function acceptRemoteClipboard(input) {
        return input != null && input.manualGetPending === true;
    }

    return {
        AUTOMATIC_SYNC: AUTOMATIC_SYNC,
        manualClipboardAllowed: manualClipboardAllowed,
        acceptRemoteClipboard: acceptRemoteClipboard
    };
}));
