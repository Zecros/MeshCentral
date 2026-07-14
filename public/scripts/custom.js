(function () {
    if (window.location.pathname.indexOf('/sharing') === -1) return;

    function byId(id) { return document.getElementById(id); }

    function setRemoteBranding() {
        if (!document.body) return;
        document.body.classList.add('nordbase-remote-share');

        var nodeName = '';
        try {
            if (typeof window.nodeName === 'string') nodeName = window.nodeName;
        } catch (e) { }
        if (!nodeName && document.title) nodeName = document.title.replace(/^Nordbase Remote\s*-\s*/, '');
        document.title = nodeName ? ('Nordbase Remote - ' + nodeName) : 'Nordbase Remote';

        var leftTools = byId('deskarea1') && byId('deskarea1').children && byId('deskarea1').children[1];
        if (leftTools && !byId('rmmRemoteBadge')) {
            var badge = document.createElement('span');
            badge.id = 'rmmRemoteBadge';
            badge.appendChild(document.createTextNode('Nordbase Remote '));
            var device = document.createElement('span');
            device.textContent = nodeName || '';
            badge.appendChild(device);
            leftTools.insertBefore(badge, leftTools.firstChild);
        }

        setValue('deskActionsSettings', 'Remote settings');
        setValue('disconnectbutton1', 'End session');
        setValue('disconnectbutton2', 'End session');
        setText('deskstatus', normalizeStatus(byId('deskstatus') && byId('deskstatus').textContent));
        setText('termstatus', normalizeStatus(byId('termstatus') && byId('termstatus').textContent));
        setText('p13Status', normalizeStatus(byId('p13Status') && byId('p13Status').textContent));

        var power = byId('p11power');
        if (power && power.textContent) {
            power.textContent = power.textContent.replace(/^Går ut kl\.\s*/i, 'Session until ');
            power.textContent = power.textContent.replace(/^Expires at\s*/i, 'Session until ');
        }
    }

    function setValue(id, value) {
        var el = byId(id);
        if (el) el.value = value;
    }

    function setText(id, value) {
        var el = byId(id);
        if (el && value) el.textContent = value;
    }

    function normalizeStatus(value) {
        value = (value || '').trim();
        if (/^(Frånkopplad|Disconnected)$/i.test(value)) return 'Waiting';
        if (/^(Ansluter|Ansluter\.\.\.|Connecting|Connecting\.\.\.)$/i.test(value)) return 'Connecting';
        if (/^(Uppstart|Uppstart\.\.\.|Setup|Setup\.\.\.)$/i.test(value)) return 'Preparing';
        if (/^(Ansluten|Connected)$/i.test(value)) return 'Connected';
        return value;
    }

    function autoConnectOnce() {
        var candidates = [
            { feature: 2, button: byId('connectbutton1'), status: byId('deskstatus') },
            { feature: 1, button: byId('connectbutton2'), status: byId('termstatus') },
            { feature: 4, button: byId('p13Connect'), status: byId('p13Status') }
        ];
        var enabledFeatures = typeof window.features === 'number' ? window.features : 0;
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            var status = (candidate.status && candidate.status.textContent || '').trim();
            if ((enabledFeatures & candidate.feature) === 0) continue;
            if (!candidate.button || candidate.button.disabled) continue;
            if (/^(Waiting|Frånkopplad|Disconnected)$/i.test(status)) {
                candidate.button.click();
                return;
            }
        }
    }

    function patchSettingsDialogTitle() {
        var title = byId('id_dialogtitle');
        if (!title || !title.textContent) return;
        if (/Remote Desktop Settings|Inställningar för fjärrskrivbord/i.test(title.textContent)) {
            title.textContent = 'Nordbase Remote settings';
        }
        var heading = document.querySelector('#dialog7 h4');
        if (heading) heading.textContent = 'Nordbase Remote';
    }

    function start() {
        setRemoteBranding();
        setTimeout(setRemoteBranding, 250);
        setTimeout(setRemoteBranding, 1000);
        setTimeout(autoConnectOnce, 700);
        setTimeout(autoConnectOnce, 2000);
        setInterval(function () {
            setRemoteBranding();
            patchSettingsDialogTitle();
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
