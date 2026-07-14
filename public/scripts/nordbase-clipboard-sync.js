(function (root, factory) {
    var api = factory();
    if ((typeof module == 'object') && (module.exports != null)) { module.exports = api; }
    if (root != null) { root.NordbaseClipboard = api; }
}(typeof globalThis == 'object' ? globalThis : this, function () {
    'use strict';

    function remoteModifier(platform) {
        return platform === 'macos' ? 0x5B : 17;
    }

    function shortcutSequence(platform, keyCode, keyAction) {
        var modifier = remoteModifier(platform);
        return [
            [keyAction.EXDOWN, modifier],
            [keyAction.DOWN, keyCode],
            [keyAction.UP, keyCode],
            [keyAction.EXUP, modifier]
        ];
    }

    function remoteClipboardDecision(input) {
        var changed = input.seeded === true && input.nextRemote !== input.lastRemote;
        return { changed: changed, shouldWriteLocal: input.force === true || changed };
    }

    return {
        remoteModifier: remoteModifier,
        shortcutSequence: shortcutSequence,
        remoteClipboardDecision: remoteClipboardDecision
    };
}));
