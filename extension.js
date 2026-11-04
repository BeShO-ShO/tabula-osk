import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { VirtualInput } from './input.js';
import { AproposKeyboard } from './keyboard.js';

const AproposQuickToggle = GObject.registerClass(
class AproposQuickToggle extends QuickSettings.QuickToggle {
    _init(extension) {
        super._init({
            title: _('Apropos Keyboard'),
            subtitle: _('Off'),
            iconName: 'input-keyboard-symbolic',
            toggleMode: true,
        });

        this._extension = extension;
        this.connect('clicked', () => {
            if (this._extension.keyboard) {
                this._extension.keyboard.toggle();
            }
        });
    }

    setActive(active) {
        this.checked = active;
        this.subtitle = active ? _('On') : _('Off');
    }
});

export default class AproposOskExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._input = new VirtualInput();

        this.keyboard = new AproposKeyboard(this._settings, this._input, this);

        // Build top panel button
        if (this._settings.get_boolean('show-panel-button')) {
            this._buildPanelButton();
        }

        // Build QuickSettings tile
        this._buildQuickToggle();

        this._settingsListener = this._settings.connect('changed::keyboard-visible', () => {
            const visible = this._settings.get_boolean('keyboard-visible');
            if (visible && !this.keyboard.isOpen) {
                this.keyboard.open();
            } else if (!visible && this.keyboard.isOpen) {
                this.keyboard.close();
            }
        });

        // Avvio: OSK nascosto a riposo
        this._settings.set_boolean('keyboard-visible', false);
        this.updateToggleState(false);

        this._startAutoShow();
    }

    _autoShowEnabled() {
        try {
            if (!this._settings.settings_schema.has_key('auto-show'))
                return false;
            return this._settings.get_boolean('auto-show');
        } catch (err) {
            return false;
        }
    }

    _startAutoShow() {
        this._autoShowSettingId = this._settings.connect('changed::auto-show', () => {
            if (this._autoShowEnabled())
                this._armAutoShow();
            else
                this._disarmAutoShow();
        });
        if (this._autoShowEnabled())
            this._armAutoShow();
    }

    _stopAutoShow() {
        if (this._autoShowSettingId && this._settings)
            this._settings.disconnect(this._autoShowSettingId);
        this._autoShowSettingId = 0;
        this._disarmAutoShow();
    }

    _armAutoShow() {
        this._disarmAutoShow();

        // Block the stock GNOME touch keyboard (except inside system dialogs)
        this._stockAllowed = null;
        this._setStockKeyboard(false);

        this._autoOpened = false;
        this._lastFocused = false;
        this._autoHideId = 0;

        this._autoPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pollTextFocus();
            return GLib.SOURCE_CONTINUE;
        });
        this._keyFocusId = global.stage.connect('notify::key-focus', () => this._pollTextFocus());
        this._lastDeviceId = global.backend.connect('last-device-changed',
            (backend, device) => this._onLastDeviceChanged(backend, device));
    }

    _disarmAutoShow() {
        if (this._autoPollId) {
            GLib.source_remove(this._autoPollId);
            this._autoPollId = 0;
        }
        if (this._autoHideId) {
            GLib.source_remove(this._autoHideId);
            this._autoHideId = 0;
        }
        if (this._keyFocusId) {
            global.stage.disconnect(this._keyFocusId);
            this._keyFocusId = 0;
        }
        if (this._lastDeviceId) {
            global.backend.disconnect(this._lastDeviceId);
            this._lastDeviceId = 0;
        }
        if (this._stockOpenId) {
            GLib.source_remove(this._stockOpenId);
            this._stockOpenId = 0;
        }
        if (this._reopenId) {
            GLib.source_remove(this._reopenId);
            this._reopenId = 0;
        }
        if (this._stockBlocked) {
            try {
                delete Main.keyboard._lastDeviceIsTouchscreen;
                if (typeof Main.keyboard._syncEnabled === 'function')
                    Main.keyboard._syncEnabled();
            } catch (err) {}
            this._stockBlocked = false;
        }
        this._autoOpened = false;
    }

    _focusInModalDialog() {
        let a = global.stage.key_focus;
        while (a) {
            if (a instanceof ModalDialog)
                return true;
            a = a.get_parent();
        }
        return false;
    }

    _setStockKeyboard(allow) {
        if (this._stockAllowed === allow)
            return;
        this._stockAllowed = allow;
        const km = Main.keyboard;
        try {
            if (!km || typeof km._lastDeviceIsTouchscreen !== 'function')
                return;
            km._lastDeviceIsTouchscreen = () => allow;
            this._stockBlocked = true;
            if (typeof km._syncEnabled === 'function')
                km._syncEnabled();
            if (allow) {
                if (this._stockOpenId)
                    GLib.source_remove(this._stockOpenId);
                this._stockOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    this._stockOpenId = 0;
                    try {
                        if (typeof km.open === 'function')
                            km.open(Main.layoutManager.focusIndex);
                        else if (km._keyboard && typeof km._keyboard.open === 'function')
                            km._keyboard.open(Main.layoutManager.focusIndex);
                    } catch (err) {
                        console.warn('[AproposOSK] Could not open stock keyboard:', err);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (err) {
            console.warn('[AproposOSK] Stock keyboard switch failed:', err);
        }
    }

    _hideOnHardwareKeyEnabled() {
        try {
            if (!this._settings.settings_schema.has_key('hide-on-hardware-key'))
                return true;
            return this._settings.get_boolean('hide-on-hardware-key');
        } catch (err) {
            return true;
        }
    }

    _onLastDeviceChanged(backend, device) {
        try {
            this._trackLastDevice(device);
            if (!device || device.device_type !== Clutter.InputDeviceType.KEYBOARD_DEVICE)
                return;
            let name = '';
            try {
                name = (device.get_device_name ? device.get_device_name() : device.name) || '';
            } catch (err) {}
            if (/virtual/i.test(name))
                return;
            // Ignore events caused by our own on-screen keyboard typing
            if (this._input && this._input.recentlyActive(300))
                return;
            if (this.keyboard && this.keyboard._tsUnknown)
                this.keyboard._tsUnknown();
            if (this.keyboard && this.keyboard.recentlyInteracted &&
                this.keyboard.recentlyInteracted(1000))
                return;
            if (!this._hideOnHardwareKeyEnabled())
                return;
            if (this._autoOpened && this.keyboard && this.keyboard.isOpen) {
                this.keyboard.close();
                this._autoOpened = false;
                this._hwClosed = true;
            }
        } catch (err) {
            console.warn('[AproposOSK] last-device handler failed:', err);
        }
    }

    _touchOnlyEnabled() {
        try {
            if (!this._settings.settings_schema.has_key('auto-show-touch-only'))
                return true;
            return this._settings.get_boolean('auto-show-touch-only');
        } catch (err) {
            return true;
        }
    }

    _lastInputWasTouch() {
        if (this._lastDeviceIsTouch !== undefined)
            return this._lastDeviceIsTouch;
        try {
            return !!global.stage.context.get_backend().get_default_seat().touch_mode;
        } catch (err) {
            return true;
        }
    }

    _trackLastDevice(device) {
        if (!device)
            return;
        const type = device.device_type;
        if (type === Clutter.InputDeviceType.KEYBOARD_DEVICE) {
            let name = '';
            try {
                name = (device.get_device_name ? device.get_device_name() : device.name) || '';
            } catch (err) {}
            // Our own on-screen typing must not count as "keyboard was last used"
            if (/virtual/i.test(name) || (this._input && this._input.recentlyActive(300)))
                return;
        }
        const touchTypes = [Clutter.InputDeviceType.TOUCHSCREEN_DEVICE,
            Clutter.InputDeviceType.PEN_DEVICE];
        this._lastDeviceIsTouch = touchTypes.includes(type);
        if (this._lastDeviceIsTouch)
            this._onTouchActivity();
    }

    _onTouchActivity() {
        // After a physical key hid the keyboard, a touch on the still-focused field reopens it
        if (!this._hwClosed || this._reopenId)
            return;
        this._reopenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._reopenId = 0;
            if (this._hwClosed && this.keyboard && !this.keyboard.isOpen &&
                this._textFieldFocused() && !this._focusInModalDialog()) {
                this.keyboard.open();
                this._autoOpened = true;
            }
            this._hwClosed = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _textFieldFocused() {
        try {
            if (Main.inputMethod && Main.inputMethod.currentFocus)
                return true;
        } catch (err) {}
        const f = global.stage.key_focus;
        return !!(f && f instanceof Clutter.Text && f.editable);
    }

    _pollTextFocus() {
        if (!this.keyboard || !this._settings)
            return;
        const inDialog = this._focusInModalDialog();
        this._setStockKeyboard(inDialog);
        if (inDialog && this.keyboard.isOpen) {
            this.keyboard.close();
            this._autoOpened = false;
        }
        const focused = !inDialog && this._textFieldFocused();
        if (focused === this._lastFocused)
            return;
        this._lastFocused = focused;
        if (!focused)
            this._hwClosed = false;

        if (focused) {
            if (this._autoHideId) {
                GLib.source_remove(this._autoHideId);
                this._autoHideId = 0;
            }
            if (!this.keyboard.isOpen &&
                (!this._touchOnlyEnabled() || this._lastInputWasTouch())) {
                this.keyboard.open();
                this._autoOpened = true;
            }
        } else if (this._autoOpened) {
            if (this._autoHideId)
                GLib.source_remove(this._autoHideId);
            // Short delay so brief focus blips (e.g. tapping the keyboard) don't hide it
            this._autoHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                if (this.keyboard && this.keyboard.recentlyInteracted &&
                    this.keyboard.recentlyInteracted(2000))
                    return GLib.SOURCE_CONTINUE;
                this._autoHideId = 0;
                if (this._autoOpened && !this._textFieldFocused() &&
                    this.keyboard && this.keyboard.isOpen)
                    this.keyboard.close();
                this._autoOpened = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _buildPanelButton() {
        this._indicator = new PanelMenu.Button(0.0, 'Apropos OSK', true);

        // Rimozione click gesture stock per propagazione diretta
        if (this._indicator._clickGesture) {
            this._indicator.remove_action(this._indicator._clickGesture);
        }

        this._icon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);

        this._indicator.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                if (this.keyboard) {
                    this.keyboard.toggle();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._indicator.connect('touch-event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_END) {
                if (this.keyboard) {
                    this.keyboard.toggle();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.panel.addToStatusArea('apropos-osk-indicator', this._indicator);
    }

    _buildQuickToggle() {
        try {
            this._quickIndicator = new QuickSettings.SystemIndicator();
            this._quickToggle = new AproposQuickToggle(this);
            this._quickIndicator.quickSettingsItems.push(this._quickToggle);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._quickIndicator);
        } catch (e) {
            console.warn('[AproposOSK] Could not add QuickSettings tile:', e);
        }
    }

    updateToggleState(isOpen) {
        if (this._indicator) {
            if (isOpen) {
                this._indicator.add_style_pseudo_class('active');
                this._indicator.add_style_pseudo_class('checked');
                this._indicator.add_style_class_name('apropos-osk-btn-active');
            } else {
                this._indicator.remove_style_pseudo_class('active');
                this._indicator.remove_style_pseudo_class('checked');
                this._indicator.remove_style_class_name('apropos-osk-btn-active');
            }
        }

        if (this._quickToggle) {
            this._quickToggle.setActive(isOpen);
        }
    }

    // The extension also runs in the 'unlock-dialog' session mode so the
    // on-screen keyboard can be used to type the password on the lock screen
    // (touch-only devices have no other way to unlock). For that reason it is
    // intentionally kept enabled while the screen is locked.
    disable() {
        this._stopAutoShow();

        if (this._settingsListener) {
            this._settings.disconnect(this._settingsListener);
            this._settingsListener = null;
        }

        if (this._quickToggle) {
            this._quickToggle.destroy();
            this._quickToggle = null;
        }

        if (this._quickIndicator) {
            this._quickIndicator.destroy();
            this._quickIndicator = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this.keyboard) {
            this.keyboard.destroy();
            this.keyboard = null;
        }

        if (this._input) {
            this._input.destroy();
            this._input = null;
        }

        this._settings = null;
    }
}
