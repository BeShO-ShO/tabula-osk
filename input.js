import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export class VirtualInput {
    constructor() {
        this._device = null;
        this._activeKeys = new Set();
        this._tapIds = new Set();
        try {
            const backend = Clutter.get_default_backend();
            if (backend) {
                const seat = backend.get_default_seat();
                if (seat) {
                    this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                }
            }
        } catch (e) {
            console.error('[AproposOSK] Failed to create virtual input device:', e);
        }
    }

    markActive() {
        this._lastActiveUs = GLib.get_monotonic_time();
    }

    recentlyActive(ms) {
        return (GLib.get_monotonic_time() - (this._lastActiveUs || 0)) < ms * 1000;
    }

    _notify(time, code, state) {
        this.markActive();
        this._device.notify_key(time, code, state);
    }

    _getTime() {
        return Clutter.get_current_event_time() * 1000;
    }

    pressKey(code) {
        if (!this._device || code <= 0) return;
        try {
            this._notify(this._getTime(), code, Clutter.KeyState.PRESSED);
            this._activeKeys.add(code);
        } catch (e) {
            console.error(`[AproposOSK] Failed to press key ${code}:`, e);
        }
    }

    releaseKey(code) {
        if (!this._device || code <= 0) return;
        try {
            this._notify(this._getTime(), code, Clutter.KeyState.RELEASED);
            this._activeKeys.delete(code);
        } catch (e) {
            console.error(`[AproposOSK] Failed to release key ${code}:`, e);
        }
    }

    tapKey(code) {
        if (!this._device || code <= 0) return;
        const time = this._getTime();
        try {
            this._notify(time, code, Clutter.KeyState.PRESSED);
            this._activeKeys.add(code);
            const id = GLib.timeout_add(GLib.PRIORITY_HIGH, 8, () => {
                this._tapIds.delete(id);
                if (this._device) {
                    this._notify(this._getTime(), code, Clutter.KeyState.RELEASED);
                    this._activeKeys.delete(code);
                }
                return GLib.SOURCE_REMOVE;
            });
            this._tapIds.add(id);
        } catch (e) {
            console.error(`[AproposOSK] Failed to tap key ${code}:`, e);
        }
    }

    releaseAll() {
        if (!this._device) return;
        const time = this._getTime();
        for (const code of this._activeKeys) {
            try {
                this._notify(time, code, Clutter.KeyState.RELEASED);
            } catch (e) {}
        }
        this._activeKeys.clear();
    }

    destroy() {
        for (const id of this._tapIds)
            GLib.source_remove(id);
        this._tapIds.clear();
        this.releaseAll();
        this._device = null;
    }
}
