import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { Layouts, loadCustomLayout, saveCustomLayout } from './layouts.js';

function bindIntToSpinRow(settings, key, spinRow) {
    spinRow.value = settings.get_int(key);
    spinRow.connect('notify::value', () => {
        const currentSetting = settings.get_int(key);
        const spinVal = Math.round(spinRow.value);
        if (currentSetting !== spinVal) {
            settings.set_int(key, spinVal);
        }
    });
    settings.connect(`changed::${key}`, () => {
        const val = settings.get_int(key);
        if (Math.round(spinRow.value) !== val) {
            spinRow.value = val;
        }
    });
}

function createColorPickerRow(title, subtitle, onColorSelected, onReset) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        valign: Gtk.Align.CENTER,
    });

    const popover = new Gtk.Popover();
    popover.set_autohide(true);

    const chooser = new Gtk.ColorChooserWidget({ use_alpha: true });
    popover.set_child(chooser);

    const swatch = new Gtk.Box({
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    });
    swatch.set_size_request(36, 22);

    const menuBtn = new Gtk.MenuButton({
        popover: popover,
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Choose color'),
    });
    menuBtn.set_child(swatch);

    function updateSwatchStyle(colorStr) {
        const provider = new Gtk.CssProvider();
        let bg = colorStr || 'transparent';
        let border = colorStr ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.2)';
        let css = `box { background-color: ${bg}; border: 1px solid ${border}; border-radius: 4px; min-width: 36px; min-height: 22px; }`;
        provider.load_from_string(css);
        swatch.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    updateSwatchStyle('');

    let internalUpdate = false;
    chooser.connect('notify::rgba', () => {
        if (internalUpdate) return;
        const rgba = chooser.get_rgba();
        if (rgba) {
            const colorStr = rgba.to_string();
            updateSwatchStyle(colorStr);
            onColorSelected(colorStr);
        }
    });

    const resetBtn = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Reset to default'),
    });
    resetBtn.connect('clicked', () => {
        updateSwatchStyle('');
        onReset();
    });

    box.append(menuBtn);
    box.append(resetBtn);
    row.add_suffix(box);
    row.activatable_widget = menuBtn;

    return {
        row,
        colorBtn: menuBtn,
        setColor: (colorStr) => {
            internalUpdate = true;
            try {
                if (!colorStr) {
                    const emptyRgba = new Gdk.RGBA();
                    emptyRgba.parse('rgba(0,0,0,0)');
                    chooser.set_rgba(emptyRgba);
                    updateSwatchStyle('');
                } else {
                    const rgba = new Gdk.RGBA();
                    if (rgba.parse(colorStr)) {
                        chooser.set_rgba(rgba);
                        updateSwatchStyle(colorStr);
                    }
                }
            } finally {
                internalUpdate = false;
            }
        }
    };
}

export default class AproposOskPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ==========================================
        // Page 1: Layout, Dimensioni & Spaziature
        // ==========================================
        const page1 = new Adw.PreferencesPage({
            title: _('Appearance and Layout'),
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(page1);

        // Group 1: Modalità Docking & Finestre
        const dockGroup = new Adw.PreferencesGroup({
            title: _('Positioning and Window Management'),
            description: _('Configure how the keyboard docks to the screen and interacts with open applications'),
        });
        page1.add(dockGroup);

        // Dock Full Strip (Strut Mode)
        const fullStripRow = new Adw.SwitchRow({
            title: _('Full-width coverage (Strut Mode)'),
            subtitle: _('The keyboard covers the full bottom width of the screen and moves/resizes windows upward so no text field is covered'),
        });
        settings.bind('dock-full-strip', fullStripRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(fullStripRow);

        // Full Strip with Centered Keys
        const centerKeysRow = new Adw.SwitchRow({
            title: _('Center keys in the full-width bar'),
            subtitle: _('In full-width mode (Strut Mode), keeps keys at standard width, centered, leaving wide margins on the left and right'),
        });
        settings.bind('full-strip-centered-keys', centerKeysRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(centerKeysRow);

        // Dock Bottom
        const dockBottomRow = new Adw.SwitchRow({
            title: _('Dock to bottom edge'),
            subtitle: _('When off, the keyboard floats freely and can be dragged around the screen'),
        });
        settings.bind('dock-bottom', dockBottomRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(dockBottomRow);

        // Padding Bottom
        const padBottomRow = new Adw.SpinRow({
            title: _('Padding from bottom edge (px)'),
            subtitle: _('Distance or safety margin from the bottom edge of the screen'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 60,
                step_increment: 2,
            }),
        });
        bindIntToSpinRow(settings, 'padding-bottom', padBottomRow);
        dockGroup.add(padBottomRow);

        // Group 2: Dimensioni
        const dimGroup = new Adw.PreferencesGroup({
            title: _('Size'),
            description: _('Adjust the width of the keyboard. To change its height, drag the bar at the top of the docked keyboard'),
        });
        page1.add(dimGroup);

        // Layout variant selector
        const layoutRow = new Adw.ComboRow({
            title: _('Active typing layout'),
            subtitle: _('Select the preset or custom layout'),
            model: new Gtk.StringList({
                strings: ['Italian (Compact TKL)', 'English (US TKL)', 'Tablet (US, Gboard style)', 'Custom Layout']
            }),
        });
        const layoutKeys = ['it', 'us', 'phone', 'custom'];
        const syncLayoutRow = () => {
            const idx = layoutKeys.indexOf(settings.get_string('layout-variant'));
            const want = idx >= 0 ? idx : 0;
            if (layoutRow.selected !== want)
                layoutRow.selected = want;
        };
        syncLayoutRow();
        layoutRow.connect('notify::selected', () => {
            const key = layoutKeys[layoutRow.selected] || 'it';
            if (settings.get_string('layout-variant') !== key)
                settings.set_string('layout-variant', key);
        });
        settings.connect('changed::layout-variant', syncLayoutRow);
        dimGroup.add(layoutRow);

        // Which layouts the [layout] button in the keyboard header cycles through
        const cycleRow = new Adw.ExpanderRow({
            title: _('Layouts in the header toggle'),
            subtitle: _('Tapping the layout name at the top left switches between these'),
        });
        const cycleNames = ['Italian (Compact TKL)', 'English (US TKL)', 'Tablet (US, Gboard style)', 'Custom Layout'];
        const cycleSwitches = layoutKeys.map((key, i) => {
            const row = new Adw.SwitchRow({ title: _(cycleNames[i]) });
            cycleRow.add_row(row);
            return row;
        });
        let cycleSyncing = false;
        const syncCycle = () => {
            cycleSyncing = true;
            const chosen = settings.get_strv('layout-cycle');
            cycleSwitches.forEach((row, i) => {
                row.active = chosen.includes(layoutKeys[i]);
            });
            const n = cycleSwitches.filter(r => r.active).length;
            // The last layout left on cannot be switched off
            cycleSwitches.forEach(row => {
                row.sensitive = !(row.active && n === 1);
            });
            cycleSyncing = false;
        };
        syncCycle();
        cycleSwitches.forEach(row => row.connect('notify::active', () => {
            if (cycleSyncing)
                return;
            const chosen = layoutKeys.filter((k, i) => cycleSwitches[i].active);
            if (chosen.length === 0) {
                syncCycle();
                return;
            }
            settings.set_strv('layout-cycle', chosen);
        }));
        settings.connect('changed::layout-cycle', syncCycle);
        dimGroup.add(cycleRow);

        // Key style
        const themeRow = new Adw.ComboRow({
            title: _('Key style'),
            subtitle: _('Fluent: the Windows 11 look. Material: a flat phone look that follows the system light or dark style'),
            model: new Gtk.StringList({ strings: [_('Fluent'), _('Material')] }),
        });
        const themeKeys = ['fluent', 'material'];
        themeRow.selected = Math.max(0, themeKeys.indexOf(settings.get_string('theme')));
        themeRow.connect('notify::selected', () => {
            settings.set_string('theme', themeKeys[themeRow.selected] || 'fluent');
        });
        dimGroup.add(themeRow);

        // Width Percent
        const widthRow = new Adw.SpinRow({
            title: _('Keyboard width (%)'),
            subtitle: _('Percentage of screen width (used when not in full-width mode)'),
            adjustment: new Gtk.Adjustment({
                lower: 40,
                upper: 100,
                step_increment: 5,
            }),
        });
        bindIntToSpinRow(settings, 'width-percent', widthRow);
        dimGroup.add(widthRow);

        // Height: set by dragging the bar at the top of the docked keyboard (stored
        // separately for landscape and portrait), so there is no field for it here

        // Group: Leggibilità del testo
        const readGroup = new Adw.PreferencesGroup({
            title: _('Text Readability and Font'),
            description: _('By default, Atkinson Hyperlegible Next is used, designed by the Braille Institute for maximum legibility, low vision, astigmatism and dyslexia'),
        });
        page1.add(readGroup);

        const fontChooserRow = new Adw.ActionRow({
            title: _('Select system font'),
            subtitle: _('Browse installed fonts visually or click the eraser to restore the default'),
        });

        const fontDialog = new Gtk.FontDialog();
        const fontDialogBtn = new Gtk.FontDialogButton({
            dialog: fontDialog,
            valign: Gtk.Align.CENTER,
        });

        const currentFont = (settings.get_string('font-family') || '').trim();
        try {
            fontDialogBtn.set_font_desc(Pango.FontDescription.from_string(currentFont ? `${currentFont} 12` : 'Atkinson Hyperlegible Next 12'));
        } catch (e) {}

        const resetFontBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset to default font (Atkinson Hyperlegible Next)'),
        });

        const fontBtnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        fontBtnBox.append(fontDialogBtn);
        fontBtnBox.append(resetFontBtn);
        fontChooserRow.add_suffix(fontBtnBox);
        fontChooserRow.activatable_widget = fontDialogBtn;
        readGroup.add(fontChooserRow);

        const fontRow = new Adw.EntryRow({
            title: _('Custom font name (empty = automatic)'),
        });
        settings.bind('font-family', fontRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        fontDialogBtn.connect('notify::font-desc', () => {
            const desc = fontDialogBtn.get_font_desc();
            if (desc) {
                const family = desc.get_family();
                if (family && family !== settings.get_string('font-family')) {
                    settings.set_string('font-family', family);
                }
            }
        });

        resetFontBtn.connect('clicked', () => {
            settings.set_string('font-family', '');
            fontRow.text = '';
            try {
                fontDialogBtn.set_font_desc(Pango.FontDescription.from_string('Atkinson Hyperlegible Next 12'));
            } catch (e) {}
        });

        settings.connect('changed::font-family', () => {
            const f = (settings.get_string('font-family') || '').trim();
            try {
                fontDialogBtn.set_font_desc(Pango.FontDescription.from_string(f ? `${f} 12` : 'Atkinson Hyperlegible Next 12'));
            } catch (e) {}
        });

        readGroup.add(fontRow);

        const fontScaleRow = new Adw.SpinRow({
            title: _('Text size (%)'),
            subtitle: _('Enlarges the labels on the keys; text shrinks automatically only if it does not fit in the key'),
            adjustment: new Gtk.Adjustment({
                lower: 80,
                upper: 160,
                step_increment: 5,
            }),
        });
        bindIntToSpinRow(settings, 'font-scale', fontScaleRow);
        readGroup.add(fontScaleRow);

        // Group 3: Spaziature tra i tasti
        const spacingGroup = new Adw.PreferencesGroup({
            title: _('Key Spacing and Margins'),
            description: _('Separate horizontal and vertical distances between individual keys and the number row'),
        });
        page1.add(spacingGroup);

        // Horizontal Gap (key-gap-x)
        const gapXRow = new Adw.SpinRow({
            title: _('Horizontal gap between keys (px)'),
            subtitle: _('Horizontal space between adjacent keys in the same row'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 16,
                step_increment: 1,
            }),
        });
        bindIntToSpinRow(settings, 'key-gap-x', gapXRow);
        spacingGroup.add(gapXRow);

        // Vertical Gap (key-gap-y)
        const gapYRow = new Adw.SpinRow({
            title: _('Vertical gap between rows (px)'),
            subtitle: _('Vertical space between one row of keys and the one below'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 16,
                step_increment: 1,
            }),
        });
        bindIntToSpinRow(settings, 'key-gap-y', gapYRow);
        spacingGroup.add(gapYRow);

        // Number row separation (TKL gap)
        const numGapRow = new Adw.SpinRow({
            title: _('Number row spacing (TKL gap) (px)'),
            subtitle: _('Extra space separating the number row from the QWERTY row'),
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 30,
                step_increment: 2,
            }),
        });
        bindIntToSpinRow(settings, 'number-row-gap', numGapRow);
        spacingGroup.add(numGapRow);

        // Key corner radius
        const radiusRow = new Adw.SpinRow({
            title: _('Key corner radius (px)'),
            subtitle: _('Windows 11-style key rounding'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
            }),
        });
        bindIntToSpinRow(settings, 'key-radius', radiusRow);
        spacingGroup.add(radiusRow);

        // Group 4: Stile Tasti Modificati (AltGr, Shift, FN)
        const modStyleGroup = new Adw.PreferencesGroup({
            title: _('Modified Key Style (AltGr, Shift, FN combinations)'),
            description: _('Choose background and contrast colors for keys that change symbol when a modifier is active (e.g. [ with AltGr or F1..F12 with FN)'),
        });
        page1.add(modStyleGroup);

        const modBgPicker = createColorPickerRow(
            _('Modified keys background color'),
            _('Background with color wheel and transparency (leave empty for the standard dark gray)'),
            (colorStr) => settings.set_string('modified-key-bg-color', colorStr),
            () => {
                settings.set_string('modified-key-bg-color', '');
                modBgPicker.setColor('');
            }
        );
        modBgPicker.setColor(settings.get_string('modified-key-bg-color'));
        modStyleGroup.add(modBgPicker.row);

        const modTextPicker = createColorPickerRow(
            _('Modified keys symbol color'),
            _('Color of the symbol shown during the high-contrast combination'),
            (colorStr) => settings.set_string('modified-key-text-color', colorStr),
            () => {
                settings.set_string('modified-key-text-color', '');
                modTextPicker.setColor('');
            }
        );
        modTextPicker.setColor(settings.get_string('modified-key-text-color'));
        modStyleGroup.add(modTextPicker.row);

        // ==========================================
        // Page 2: Reattività & Gesti
        // ==========================================
        const page2 = new Adw.PreferencesPage({
            title: _('Responsiveness and Gestures'),
            icon_name: 'input-touchpad-symbolic',
        });
        window.add(page2);

        // Group: Key repeat & fluid writing
        const speedGroup = new Adw.PreferencesGroup({
            title: _('Typing Speed (Android / GBoard style)'),
            description: _('Responsiveness for Backspace and continuous fast deletion'),
        });
        page2.add(speedGroup);

        // Repeat delay
        const delayRow = new Adw.SpinRow({
            title: _('Repeat start delay (ms)'),
            subtitle: _('Wait time before a held key starts repeating (default: 320ms)'),
            adjustment: new Gtk.Adjustment({
                lower: 150,
                upper: 800,
                step_increment: 20,
            }),
        });
        bindIntToSpinRow(settings, 'repeat-delay', delayRow);
        speedGroup.add(delayRow);

        // Repeat rate
        const rateRow = new Adw.SpinRow({
            title: _('Repeat interval (ms)'),
            subtitle: _('Continuous repeat rate (default: 36ms for maximum smoothness)'),
            adjustment: new Gtk.Adjustment({
                lower: 15,
                upper: 120,
                step_increment: 5,
            }),
        });
        bindIntToSpinRow(settings, 'repeat-interval', rateRow);
        speedGroup.add(rateRow);

        // Spacebar and Backspace Gestures
        const gestureGroup = new Adw.PreferencesGroup({
            title: _('Swipe Gestures (Space and Backspace)'),
            description: _('GBoard-style gestures: cursor sliding on the space bar and backward deletion on Backspace'),
        });
        page2.add(gestureGroup);

        // Spacebar sensitivity
        const sensRow = new Adw.SpinRow({
            title: _('Space cursor sensitivity (px/character)'),
            subtitle: _('Pixels of horizontal drag on the space bar for each character moved'),
            adjustment: new Gtk.Adjustment({
                lower: 6,
                upper: 40,
                step_increment: 2,
            }),
        });
        bindIntToSpinRow(settings, 'space-slider-sensitivity', sensRow);
        gestureGroup.add(sensRow);

        // Backspace sensitivity
        const backspaceSensRow = new Adw.SpinRow({
            title: _('Backspace backward swipe sensitivity (px/character)'),
            subtitle: _('Pixels of leftward drag on Backspace to select each character to delete'),
            adjustment: new Gtk.Adjustment({
                lower: 8,
                upper: 45,
                step_increment: 2,
            }),
        });
        bindIntToSpinRow(settings, 'backspace-slider-sensitivity', backspaceSensRow);
        gestureGroup.add(backspaceSensRow);

        // Sound switch
        const soundRow = new Adw.SwitchRow({
            title: _('Sound feedback on key press'),
            subtitle: _('Plays a soft click sound when each key is touched'),
        });
        settings.bind('play-sound', soundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(soundRow);

        // Top panel button
        const panelRow = new Adw.SwitchRow({
            title: _('Top panel button'),
            subtitle: _('Shows the keyboard icon in the top bar to open/close it with one click'),
        });
        settings.bind('show-panel-button', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(panelRow);

        // Auto-show on text field focus
        const autoShowRow = new Adw.SwitchRow({
            title: _('Pop up when a text field is selected'),
            subtitle: _('Opens the keyboard automatically on text fields and hides it when you leave them. Also blocks the default GNOME keyboard'),
        });
        settings.bind('auto-show', autoShowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(autoShowRow);

        // Hide on physical key
        const hwKeyRow = new Adw.SwitchRow({
            title: _('Hide when a physical key is pressed'),
            subtitle: _('Closes an automatically opened keyboard as soon as you type on the Type Cover or another hardware keyboard'),
        });
        settings.bind('hide-on-hardware-key', hwKeyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(hwKeyRow);

        // Touch-only auto popup
        const touchOnlyRow = new Adw.SwitchRow({
            title: _('Pop up only after touch'),
            subtitle: _('Opens automatically only when you tap a field with touch or pen, not when you get there with the keyboard, touchpad or mouse'),
        });
        settings.bind('auto-show-touch-only', touchOnlyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(touchOnlyRow);

        // Word suggestions
        const suggestRow = new Adw.SwitchRow({
            title: _('Word suggestions'),
            subtitle: _('Shows three word completions above the keys while you type on the on-screen keyboard. Learned words stay on this computer; password fields are never recorded'),
        });
        settings.bind('suggestions-enabled', suggestRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(suggestRow);

        // Word suggestions from ibus-typing-booster
        const boosterRow = new Adw.SwitchRow({
            title: _('Use Typing Booster for suggestions'),
            subtitle: _('Takes the suggestions from ibus-typing-booster, which sees the real text and learns your words. Needs word suggestions turned on. While the keyboard is open, the input method switches to Typing Booster and switches back when it closes. Falls back to the built-in list if Typing Booster is not installed'),
        });
        settings.bind('use-typing-booster', boosterRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('suggestions-enabled', boosterRow, 'sensitive', Gio.SettingsBindFlags.GET);
        gestureGroup.add(boosterRow);

        // Group: Digitazione Intelligente
        const smartGroup = new Adw.PreferencesGroup({
            title: _('Smart Typing'),
            description: _('Brackets and quotes, accents, capitals, periods and spelling'),
        });
        page2.add(smartGroup);

        const autoPairsRow = new Adw.SwitchRow({
            title: _('Smart bracket and quote completion'),
            subtitle: _('Automatically closes pairs (), [], {}, "" placing the cursor in the middle, and steps over the closing character if you type it out of habit'),
        });
        settings.bind('smart-auto-pairs', autoPairsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(autoPairsRow);

        const longPressRow = new Adw.SwitchRow({
            title: _('Hold keys for accents and symbols'),
            subtitle: _('On the Tablet layout, holding a key opens a row of accented letters and symbols; slide to one and let go. The symbol in the corner of each key comes first'),
        });
        settings.bind('long-press', longPressRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(longPressRow);

        const longPressDelayRow = new Adw.SpinRow({
            title: _('Hold time (ms)'),
            subtitle: _('How long to hold a key before the accents and symbols appear'),
            adjustment: new Gtk.Adjustment({
                lower: 150,
                upper: 900,
                step_increment: 25,
            }),
        });
        bindIntToSpinRow(settings, 'long-press-delay', longPressDelayRow);
        settings.bind('long-press', longPressDelayRow, 'sensitive', Gio.SettingsBindFlags.GET);
        smartGroup.add(longPressDelayRow);

        const autoCapRow = new Adw.SwitchRow({
            title: _('Auto-capitalization'),
            subtitle: _('Shift turns on by itself at the start of a sentence and of an empty field. It only affects letters. Tap Shift to type a small letter instead'),
        });
        settings.bind('auto-capitalize', autoCapRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(autoCapRow);

        const doubleSpaceRow = new Adw.SwitchRow({
            title: _('Double-space for a period'),
            subtitle: _('Tapping space twice after a word types a period and a space'),
        });
        settings.bind('double-space-period', doubleSpaceRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(doubleSpaceRow);

        const autocorrectRow = new Adw.SwitchRow({
            title: _('Autocorrect (English)'),
            subtitle: _('Fixes misspelled words when you type a space or punctuation, using the system spell checker (Enchant/Hunspell). Press Backspace right after a correction to undo it; that word is then left alone. Never used in password, terminal, URL or e-mail fields'),
        });
        settings.bind('autocorrect', autocorrectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(autocorrectRow);

        // ==========================================
        // Page 3: Studio Customizzazione Layout Completa
        // ==========================================
        this._buildLayoutStudioPage(window, settings, layoutRow);
    }

    _buildLayoutStudioPage(window, settings, layoutSelectorRow) {
        const page3 = new Adw.PreferencesPage({
            title: _('Layout and Keys Studio'),
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        window.add(page3);

        let editingLayout = loadCustomLayout();
        if (!editingLayout) {
            editingLayout = JSON.parse(JSON.stringify(Layouts.it));
            editingLayout.name = 'Custom';
        }

        let selectedRowIdx = 0;
        let selectedKeyIdx = 0;

        // Group 1: Toolbar azioni
        const actionsGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Layout Customization'),
            description: _('Edit any key: change its label, flex size, behavior (normal or ON/OFF toggle), colors and position'),
        });
        page3.add(actionsGroup);

        // Responsive two-row action toolbar (fits in narrow floating windows without overflow)
        const mainToolbarBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 4,
            margin_bottom: 6,
            halign: Gtk.Align.CENTER,
        });

        const toolbarRow1 = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });
        const resetItBtn = new Gtk.Button({ label: _('Reset to Italian') });
        resetItBtn.connect('clicked', () => {
            editingLayout = JSON.parse(JSON.stringify(Layouts.it));
            editingLayout.name = 'Custom';
            selectedRowIdx = 0;
            selectedKeyIdx = 0;
            renderVisualKeyboard();
            updateInspector();
        });
        toolbarRow1.append(resetItBtn);

        const resetUsBtn = new Gtk.Button({ label: _('Reset to US') });
        resetUsBtn.connect('clicked', () => {
            editingLayout = JSON.parse(JSON.stringify(Layouts.us));
            editingLayout.name = 'Custom';
            selectedRowIdx = 0;
            selectedKeyIdx = 0;
            renderVisualKeyboard();
            updateInspector();
        });
        toolbarRow1.append(resetUsBtn);
        mainToolbarBox.append(toolbarRow1);

        const toolbarRow2 = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });
        const addKeyBtn = new Gtk.Button({
            label: _('+ Add Key'),
            css_classes: ['accent'],
        });
        addKeyBtn.connect('clicked', () => {
            const targetRow = (selectedRowIdx === 0)
                ? editingLayout.numberRow
                : editingLayout.mainRows[selectedRowIdx - 1];

            const newKey = {
                code: 0,
                label: 'New',
                shift: '',
                altgr: '',
                width: 1.0,
                type: 'char',
                behavior: 'normal',
                bgColor: '',
                textColor: '',
                activeColor: '',
            };
            targetRow.push(newKey);
            selectedKeyIdx = targetRow.length - 1;
            renderVisualKeyboard();
            updateInspector();
        });
        toolbarRow2.append(addKeyBtn);

        const deleteToolbarBtn = new Gtk.Button({
            label: _('- Delete Key'),
            css_classes: ['destructive-action'],
        });
        deleteToolbarBtn.connect('clicked', () => {
            const row = getCurrentRow();
            if (row && row.length > 1) {
                row.splice(selectedKeyIdx, 1);
                selectedKeyIdx = Math.max(0, selectedKeyIdx - 1);
                renderVisualKeyboard();
                updateInspector();
            }
        });
        toolbarRow2.append(deleteToolbarBtn);

        const saveApplyBtn = new Gtk.Button({
            label: _('Save and Apply'),
            css_classes: ['suggested-action'],
        });
        saveApplyBtn.connect('clicked', () => {
            saveCustomLayout(editingLayout);
            settings.set_string('layout-variant', 'custom');
            // Bump token to trigger live reload in keyboard.js immediately!
            const token = (settings.get_int('custom-layout-token') || 0) + 1;
            settings.set_int('custom-layout-token', token);

            if (layoutSelectorRow) {
                layoutSelectorRow.selected = 3;   // Custom Layout
            }
            if (window.add_toast) {
                window.add_toast(new Adw.Toast({
                    title: _('Custom layout saved and applied live!'),
                }));
            }
        });
        toolbarRow2.append(saveApplyBtn);
        mainToolbarBox.append(toolbarRow2);

        const actionRow = new Adw.ActionRow();
        actionRow.set_child(mainToolbarBox);
        actionsGroup.add(actionRow);

        // Group 2: Anteprima Interattiva della Tastiera (Scrollable & Responsive)
        const previewGroup = new Adw.PreferencesGroup({
            title: _('Interactive Preview (Click a key to select it)'),
        });
        page3.add(previewGroup);

        const keyboardCanvas = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 4,
            margin_end: 4,
        });

        const canvasProvider = new Gtk.CssProvider();
        canvasProvider.load_from_string(`
            box {
                background-color: #1a1a1e;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 10px;
                padding: 6px 8px 8px 8px;
            }
        `);
        keyboardCanvas.get_style_context().add_provider(canvasProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const scrolledPreview = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_width: true,
            min_content_height: 220,
            has_frame: false,
        });
        scrolledPreview.set_child(keyboardCanvas);

        const canvasContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 4,
            margin_bottom: 4,
        });
        canvasContainer.append(scrolledPreview);

        const previewRow = new Adw.ActionRow();
        previewRow.set_child(canvasContainer);
        previewGroup.add(previewRow);

        // Group 3: Proprietà Tasto Selezionato (Inspector)
        const inspectorGroup = new Adw.PreferencesGroup({
            title: _('Selected Key Properties'),
            description: _('Edit the values of the key selected in the preview above'),
        });
        page3.add(inspectorGroup);

        // Label Entry
        const labelRow = new Adw.EntryRow({
            title: _('Main Label'),
        });
        labelRow.connect('changed', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.label = labelRow.text;
                renderVisualKeyboard();
            }
        });
        inspectorGroup.add(labelRow);

        // Shift Entry
        const shiftRow = new Adw.EntryRow({
            title: _('Character with Shift'),
        });
        shiftRow.connect('changed', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.shift = shiftRow.text;
            }
        });
        inspectorGroup.add(shiftRow);

        // AltGr Entry
        const altgrRow = new Adw.EntryRow({
            title: _('Character with Alt Gr'),
        });
        altgrRow.connect('changed', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.altgr = altgrRow.text;
            }
        });
        inspectorGroup.add(altgrRow);

        // Shift+AltGr Entry (for advanced Italian symbols like { and })
        const shiftAltgrRow = new Adw.EntryRow({
            title: _('Character with Shift + Alt Gr'),
        });
        shiftAltgrRow.connect('changed', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.shiftAltgr = shiftAltgrRow.text;
            }
        });
        inspectorGroup.add(shiftAltgrRow);

        // Key Width (Flex multiplier)
        const keyWidthRow = new Adw.SpinRow({
            title: _('Relative width (Flex units)'),
            subtitle: _('Independent horizontal size (e.g. 1.0 standard, 1.5 tab, 6.5 space)'),
            adjustment: new Gtk.Adjustment({
                lower: 0.4,
                upper: 8.0,
                step_increment: 0.1,
                page_increment: 0.5,
            }),
            digits: 2,
        });
        keyWidthRow.connect('notify::value', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.width = Math.round(keyWidthRow.value * 100) / 100;
                renderVisualKeyboard();
            }
        });
        inspectorGroup.add(keyWidthRow);

        // Key Linux Evdev Code
        const keycodeRow = new Adw.SpinRow({
            title: _('Linux Key Code (Evdev Keycode)'),
            subtitle: _('Numeric key value (e.g. 16 for Q, 57 for Space, 14 for Backspace)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 255,
                step_increment: 1,
            }),
        });
        keycodeRow.connect('notify::value', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.code = Math.round(keycodeRow.value);
            }
        });
        inspectorGroup.add(keycodeRow);

        // Behavior Mode (Normale vs Toggle ON/OFF)
        const behaviorRow = new Adw.ComboRow({
            title: _('Key Behavior'),
            subtitle: _('Choose whether the key works with a normal tap/press or as an ON/OFF switch'),
            model: new Gtk.StringList({
                strings: ['Normal (Press / Continuous repeat)', 'ON/OFF Switch (Toggles on each tap)']
            }),
        });
        behaviorRow.connect('notify::selected', () => {
            if (updatingInspector) return;
            const k = getSelectedKey();
            if (k) {
                k.behavior = (behaviorRow.selected === 1) ? 'toggle' : 'normal';
                renderVisualKeyboard();
            }
        });
        inspectorGroup.add(behaviorRow);

        // Custom Background Color Picker
        const bgPicker = createColorPickerRow(
            _('Custom Background Color'),
            _('Choose with color wheel and transparency (or click the icon for default)'),
            (colorStr) => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.bgColor = colorStr;
                    renderVisualKeyboard();
                }
            },
            () => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.bgColor = '';
                    bgPicker.setColor('');
                    renderVisualKeyboard();
                }
            }
        );
        inspectorGroup.add(bgPicker.row);

        // Custom Text Color Picker
        const textPicker = createColorPickerRow(
            _('Text / Label Color'),
            _('Choose the color of the symbol shown on the key'),
            (colorStr) => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.textColor = colorStr;
                    renderVisualKeyboard();
                }
            },
            () => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.textColor = '';
                    textPicker.setColor('');
                    renderVisualKeyboard();
                }
            }
        );
        inspectorGroup.add(textPicker.row);

        // Custom Pressed / Active Color Picker
        const activePicker = createColorPickerRow(
            _('Pressed / Active ON Color'),
            _('Color when the key is pressed or activated in switch mode'),
            (colorStr) => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.activeColor = colorStr;
                }
            },
            () => {
                if (updatingInspector) return;
                const k = getSelectedKey();
                if (k) {
                    k.activeColor = '';
                    activePicker.setColor('');
                }
            }
        );
        inspectorGroup.add(activePicker.row);

        // Responsive Move & Delete actions box
        const moveContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 8,
            margin_bottom: 8,
            halign: Gtk.Align.CENTER,
        });

        const moveDirsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
        });

        const moveLeftBtn = new Gtk.Button({ label: _('<- Left') });
        moveLeftBtn.connect('clicked', () => {
            const row = getCurrentRow();
            if (row && selectedKeyIdx > 0) {
                const temp = row[selectedKeyIdx];
                row[selectedKeyIdx] = row[selectedKeyIdx - 1];
                row[selectedKeyIdx - 1] = temp;
                selectedKeyIdx--;
                renderVisualKeyboard();
            }
        });
        moveDirsBox.append(moveLeftBtn);

        const moveRightBtn = new Gtk.Button({ label: _('-> Right') });
        moveRightBtn.connect('clicked', () => {
            const row = getCurrentRow();
            if (row && selectedKeyIdx < row.length - 1) {
                const temp = row[selectedKeyIdx];
                row[selectedKeyIdx] = row[selectedKeyIdx + 1];
                row[selectedKeyIdx + 1] = temp;
                selectedKeyIdx++;
                renderVisualKeyboard();
            }
        });
        moveDirsBox.append(moveRightBtn);

        const moveUpBtn = new Gtk.Button({ label: _('^ Row Up') });
        moveUpBtn.connect('clicked', () => {
            if (selectedRowIdx > 0) {
                const currRow = getCurrentRow();
                const [movedKey] = currRow.splice(selectedKeyIdx, 1);
                selectedRowIdx--;
                const targetRow = getCurrentRow();
                targetRow.push(movedKey);
                selectedKeyIdx = targetRow.length - 1;
                renderVisualKeyboard();
                updateInspector();
            }
        });
        moveDirsBox.append(moveUpBtn);

        const moveDownBtn = new Gtk.Button({ label: _('v Row Down') });
        moveDownBtn.connect('clicked', () => {
            const maxRow = (editingLayout.mainRows ? editingLayout.mainRows.length : 4);
            if (selectedRowIdx < maxRow) {
                const currRow = getCurrentRow();
                const [movedKey] = currRow.splice(selectedKeyIdx, 1);
                selectedRowIdx++;
                const targetRow = getCurrentRow();
                targetRow.push(movedKey);
                selectedKeyIdx = targetRow.length - 1;
                renderVisualKeyboard();
                updateInspector();
            }
        });
        moveDirsBox.append(moveDownBtn);
        moveContainer.append(moveDirsBox);

        const moveActionRow = new Adw.ActionRow();
        moveActionRow.set_child(moveContainer);
        inspectorGroup.add(moveActionRow);

        // Helper functions for state
        function getCurrentRow() {
            if (selectedRowIdx === 0) {
                return editingLayout.numberRow;
            }
            if (editingLayout.mainRows && editingLayout.mainRows[selectedRowIdx - 1]) {
                return editingLayout.mainRows[selectedRowIdx - 1];
            }
            return null;
        }

        function getSelectedKey() {
            const row = getCurrentRow();
            if (row && row[selectedKeyIdx]) {
                return row[selectedKeyIdx];
            }
            return null;
        }

        let updatingInspector = false;
        function updateInspector() {
            const key = getSelectedKey();
            if (!key) return;

            updatingInspector = true;
            try {
                labelRow.text = key.label || '';
                shiftRow.text = key.shift || '';
                altgrRow.text = key.altgr || '';
                shiftAltgrRow.text = key.shiftAltgr || '';
                keyWidthRow.value = key.width || 1.0;
                keycodeRow.value = key.code || 0;
                behaviorRow.selected = (key.behavior === 'toggle') ? 1 : 0;
                bgPicker.setColor(key.bgColor || '');
                textPicker.setColor(key.textColor || '');
                activePicker.setColor(key.activeColor || '');
            } finally {
                updatingInspector = false;
            }
        }

        let previewShiftActive = false;
        let previewAltgrActive = false;
        let previewFnActive = false;

        function renderVisualKeyboard() {
            while (keyboardCanvas.get_first_child()) {
                keyboardCanvas.remove(keyboardCanvas.get_first_child());
            }

            // Realistic Mini Header
            const miniHeader = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                margin_bottom: 6,
                hexpand: true,
            });

            const layoutBadge = new Gtk.Label({
                label: `[${(editingLayout.name || 'Layout').toUpperCase()}]`,
                halign: Gtk.Align.START,
                valign: Gtk.Align.CENTER,
            });
            const badgeProvider = new Gtk.CssProvider();
            badgeProvider.load_from_string('label { font-size: 11px; font-weight: bold; color: rgba(255, 255, 255, 0.75); }');
            layoutBadge.get_style_context().add_provider(badgeProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            miniHeader.append(layoutBadge);

            const handleBox = new Gtk.Box({
                hexpand: true,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            const miniHandle = new Gtk.Box();
            miniHandle.set_size_request(56, 4);
            const handleProvider = new Gtk.CssProvider();
            handleProvider.load_from_string('box { background-color: rgba(255, 255, 255, 0.4); border-radius: 2px; }');
            miniHandle.get_style_context().add_provider(handleProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            handleBox.append(miniHandle);
            miniHeader.append(handleBox);

            // Interactive modifier preview toggles & header simulation
            const previewControlsBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 4,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
            });

            const makeSimToggle = (label, isActive, onToggle) => {
                const btn = new Gtk.Button({ label });
                const prov = new Gtk.CssProvider();
                prov.load_from_string(`
                    button {
                        background-color: ${isActive ? '#0078d4' : 'rgba(255, 255, 255, 0.08)'};
                        color: ${isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.75)'};
                        font-size: 10px;
                        font-weight: ${isActive ? 'bold' : 'normal'};
                        border: 1px solid ${isActive ? '#2b88d8' : 'rgba(255, 255, 255, 0.14)'};
                        border-radius: 4px;
                        padding: 2px 6px;
                    }
                `);
                btn.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
                btn.connect('clicked', onToggle);
                return btn;
            };

            const shiftSimBtn = makeSimToggle('Shift', previewShiftActive, () => {
                previewShiftActive = !previewShiftActive;
                renderVisualKeyboard();
            });
            previewControlsBox.append(shiftSimBtn);

            const altgrSimBtn = makeSimToggle('AltGr', previewAltgrActive, () => {
                previewAltgrActive = !previewAltgrActive;
                renderVisualKeyboard();
            });
            previewControlsBox.append(altgrSimBtn);

            const fnSimBtn = makeSimToggle('FN', previewFnActive, () => {
                previewFnActive = !previewFnActive;
                renderVisualKeyboard();
            });
            previewControlsBox.append(fnSimBtn);

            const dummyControls = new Gtk.Label({
                label: '[Dock] [X]',
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
            });
            const dummyProv = new Gtk.CssProvider();
            dummyProv.load_from_string('label { font-size: 10px; color: rgba(255, 255, 255, 0.45); margin-left: 4px; }');
            dummyControls.get_style_context().add_provider(dummyProv, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            previewControlsBox.append(dummyControls);

            miniHeader.append(previewControlsBox);
            keyboardCanvas.append(miniHeader);

            // Assemble rows
            const allRows = [];
            if (editingLayout.numberRow) {
                allRows.push(editingLayout.numberRow);
            }
            if (editingLayout.mainRows) {
                for (const r of editingLayout.mainRows) {
                    allRows.push(r);
                }
            }

            for (let r = 0; r < allRows.length; r++) {
                const rowDef = allRows[r];
                const isNumRow = (r === 0);
                const rowBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 4,
                    hexpand: true,
                    margin_bottom: isNumRow ? 6 : 4,
                });

                if (isNumRow) {
                    const numRowProv = new Gtk.CssProvider();
                    numRowProv.load_from_string('box { border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 4px; }');
                    rowBox.get_style_context().add_provider(numRowProv, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
                }

                for (let k = 0; k < rowDef.length; k++) {
                    const keyDef = rowDef[k];
                    const isSelected = (r === selectedRowIdx && k === selectedKeyIdx);

                    let targetLabel = keyDef.label || '';
                    let modTone = null; // 'shift', 'altgr', 'both', 'fn'

                    if (previewFnActive && isNumRow) {
                        const fnMap = {
                            2: 'F1', 3: 'F2', 4: 'F3', 5: 'F4', 6: 'F5', 7: 'F6',
                            8: 'F7', 9: 'F8', 10: 'F9', 11: 'F10', 12: 'F11', 13: 'F12'
                        };
                        targetLabel = fnMap[keyDef.code] || `F${k + 1}`;
                        modTone = 'fn';
                    } else if (previewShiftActive && previewAltgrActive && keyDef.shiftAltgr) {
                        targetLabel = keyDef.shiftAltgr;
                        modTone = 'both';
                    } else if (previewAltgrActive && keyDef.altgr) {
                        targetLabel = keyDef.altgr;
                        modTone = 'altgr';
                    } else if (previewShiftActive && keyDef.shift) {
                        targetLabel = keyDef.shift;
                        if (!(keyDef.label && keyDef.label.length === 1 && keyDef.label.match(/[a-z]/i))) {
                            modTone = 'shift';
                        }
                    } else if (previewShiftActive && keyDef.label && keyDef.label.length === 1 && keyDef.label.match(/[a-z]/i)) {
                        targetLabel = keyDef.shift || keyDef.label.toUpperCase();
                    } else {
                        targetLabel = keyDef.label || '';
                    }

                    const isEnterTop = (keyDef.type === 'enter' && keyDef.enterPart === 'top');
                    const isEnterBottom = (keyDef.type === 'enter' && keyDef.enterPart === 'bottom');

                    if (keyDef.type === 'enter') {
                        if (previewShiftActive) {
                            targetLabel = isEnterBottom ? '↵' : '↵ New line';
                        } else {
                            targetLabel = keyDef.label || (isEnterBottom ? '↵' : 'Enter ↵');
                        }
                    }

                    const btn = new Gtk.Button({
                        hexpand: false,
                        can_focus: false,
                    });

                    const baseWidth = Math.max(26, Math.round((keyDef.width || 1.0) * 36));
                    let baseHeight = isNumRow ? 32 : 36;
                    if (isEnterTop) {
                        baseHeight = 36 + 4;
                    }
                    btn.set_size_request(baseWidth, baseHeight);

                    const singleLbl = new Gtk.Label({
                        label: targetLabel || ' ',
                        halign: Gtk.Align.CENTER,
                        valign: Gtk.Align.CENTER,
                    });
                    const isSingleChar = (targetLabel.length === 1);
                    const customFont = (settings.get_string('font-family') || '').trim();
                    const previewFontFamily = customFont ? `"${customFont}", "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", sans-serif` : '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", sans-serif';
                    const lblProv = new Gtk.CssProvider();
                    lblProv.load_from_string(`label { font-family: ${previewFontFamily}; font-size: ${isSingleChar ? '13px' : '10px'}; font-weight: ${modTone || isSelected ? '700' : '500'}; }`);
                    singleLbl.get_style_context().add_provider(lblProv, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
                    btn.set_child(singleLbl);

                    // Keycap styling matching authentic OSK
                    let bg = keyDef.bgColor || 'rgba(255, 255, 255, 0.08)';
                    let border = '1px solid rgba(255, 255, 255, 0.08)';
                    let borderTop = '1px solid rgba(255, 255, 255, 0.14)';
                    let borderBottom = '2px solid rgba(0, 0, 0, 0.45)';
                    let borderRadius = '6px';
                    let color = keyDef.textColor || '#f3f3f3';
                    let boxShadow = '0 1px 2px rgba(0, 0, 0, 0.2)';

                    if (isEnterTop) {
                        borderRadius = '6px 6px 0 4px';
                        borderBottom = 'none';
                    } else if (isEnterBottom) {
                        borderRadius = '0 0 6px 6px';
                        borderTop = 'none';
                    }

                    if (keyDef.type === 'enter') {
                        if (previewShiftActive) {
                            bg = 'rgba(70, 135, 195, 0.40)';
                            border = '1px solid rgba(160, 205, 255, 0.65)';
                            color = '#edf5ff';
                            boxShadow = '0 0 6px rgba(0, 120, 212, 0.40)';
                        } else {
                            bg = keyDef.bgColor || 'rgba(0, 120, 212, 0.22)';
                            border = '1px solid rgba(0, 120, 212, 0.45)';
                            color = keyDef.textColor || '#60cdff';
                        }
                    } else if (keyDef.type === 'shift' && previewShiftActive) {
                        bg = '#0078d4';
                        border = '1px solid #2b88d8';
                        color = '#ffffff';
                        boxShadow = '0 0 8px rgba(0, 120, 212, 0.6)';
                    } else if (keyDef.type === 'altgr' && previewAltgrActive) {
                        bg = '#0078d4';
                        border = '1px solid #2b88d8';
                        color = '#ffffff';
                        boxShadow = '0 0 8px rgba(0, 120, 212, 0.6)';
                    } else if (keyDef.type === 'fn_toggle' && previewFnActive) {
                        bg = '#0078d4';
                        border = '1px solid #2b88d8';
                        color = '#ffffff';
                        boxShadow = '0 0 8px rgba(0, 120, 212, 0.6)';
                    } else if (modTone === 'both') {
                        bg = 'rgba(75, 120, 90, 0.58)';
                        border = '1px solid rgba(140, 215, 165, 0.35)';
                        borderTop = '1px solid rgba(140, 215, 165, 0.50)';
                        color = '#ffffff';
                        boxShadow = '0 0 6px rgba(80, 160, 110, 0.35)';
                    } else if (modTone === 'altgr') {
                        bg = 'rgba(45, 75, 55, 0.52)';
                        border = '1px solid rgba(110, 175, 130, 0.22)';
                        borderTop = '1px solid rgba(110, 175, 130, 0.38)';
                        color = '#f0faf2';
                    } else if (modTone === 'shift') {
                        bg = 'rgba(255, 255, 255, 0.16)';
                        borderTop = '1px solid rgba(255, 255, 255, 0.28)';
                        color = '#ffffff';
                    } else if (modTone === 'fn') {
                        bg = 'rgba(255, 255, 255, 0.18)';
                        borderTop = '1px solid rgba(255, 255, 255, 0.30)';
                        color = '#ffffff';
                    } else if (['shift', 'caps', 'altgr', 'ctrl', 'alt', 'fn_toggle', 'tab'].includes(keyDef.type)) {
                        bg = keyDef.bgColor || 'rgba(255, 255, 255, 0.04)';
                        color = keyDef.textColor || 'rgba(255, 255, 255, 0.85)';
                    } else {
                        bg = keyDef.bgColor || 'rgba(255, 255, 255, 0.08)';
                    }

                    if (isSelected) {
                        boxShadow = '0 0 8px rgba(0, 120, 212, 0.9)';
                        border = '2px solid #60cdff';
                    }

                    const btnProvider = new Gtk.CssProvider();
                    const css = `
                        button {
                            background-color: ${bg};
                            background-image: none;
                            border: ${border};
                            border-top: ${borderTop};
                            border-bottom: ${borderBottom};
                            border-radius: ${borderRadius};
                            color: ${color};
                            padding: 0;
                            box-shadow: ${boxShadow};
                        }
                    `;
                    btnProvider.load_from_string(css);
                    btn.get_style_context().add_provider(btnProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

                    const thisRow = r;
                    const thisKey = k;
                    btn.connect('clicked', () => {
                        selectedRowIdx = thisRow;
                        selectedKeyIdx = thisKey;
                        renderVisualKeyboard();
                        updateInspector();
                    });

                    rowBox.append(btn);
                }
                keyboardCanvas.append(rowBox);
            }
        }

        // Initial render
        renderVisualKeyboard();
        updateInspector();

        settings.connect('changed::font-family', () => {
            renderVisualKeyboard();
        });
    }
}
