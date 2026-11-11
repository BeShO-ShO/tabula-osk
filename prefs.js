import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
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
// A small (i) button that shows longer help in a popover (works with touch, unlike tooltips)
function infoButton(text) {
    const label = new Gtk.Label({
        label: text,
        wrap: true,
        max_width_chars: 42,
        xalign: 0,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
    });
    const popover = new Gtk.Popover();
    popover.set_child(label);
    return new Gtk.MenuButton({
        icon_name: 'help-about-symbolic',
        popover,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
        tooltip_text: _('More information'),
    });
}

// On/off row bound to a boolean key, with an optional (i) button before the switch
function switchRow(settings, key, title, subtitle, info) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || '' });
    if (info)
        row.add_suffix(infoButton(info));
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return row;
}

// Expander whose own switch is the boolean key; its child rows are the options that depend on it
function expanderSwitch(settings, key, title, subtitle, info) {
    const row = new Adw.ExpanderRow({
        title,
        subtitle: subtitle || '',
        show_enable_switch: true,
    });
    if (info)
        row.add_suffix(infoButton(info));
    settings.bind(key, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    // Turning the switch on expands the row; start collapsed anyway
    row.expanded = false;
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle: subtitle || '',
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step }),
    });
    bindIntToSpinRow(settings, key, row);
    return row;
}

const DEFAULT_FONT = 'Atkinson Hyperlegible Next';

// Layouts offered in the settings. Italian stays in the code (and in the menu only if it is
// the layout in use) but is not offered otherwise.
const LAYOUT_CHOICES = [
    ['us', 'US (TKL)'],
    ['phone', 'Tablet (US, Gboard style)'],
    ['custom', 'Custom'],
];

export default class TabulaOskPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.search_enabled = true;
        window.add(this._buildTypingPage(settings));
        window.add(this._buildShowingPage(settings));
        window.add(this._buildLookPage(window, settings));
    }

    // ==========================================
    // Page 1: Typing (what the keys do)
    // ==========================================
    _buildTypingPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Typing'),
            icon_name: 'input-keyboard-symbolic',
        });

        const suggestGroup = new Adw.PreferencesGroup({ title: _('Suggestions and Corrections') });
        page.add(suggestGroup);

        const suggestRow = expanderSwitch(settings, 'suggestions-enabled',
            _('Word suggestions'),
            _('Three word completions above the keys'),
            _('Learned words stay on this computer. Password fields are never recorded.'));
        suggestRow.add_row(switchRow(settings, 'use-typing-booster',
            _('Use Typing Booster'),
            _('Take the suggestions from ibus-typing-booster'),
            _('Typing Booster sees the real text and learns your words. While the keyboard is open, the input method switches to Typing Booster and switches back when it closes. If Typing Booster is not installed, the built-in word list is used.')));
        suggestGroup.add(suggestRow);

        suggestGroup.add(switchRow(settings, 'autocorrect',
            _('Autocorrect'),
            _('Fix misspelled English words on space or punctuation'),
            _('Uses the system spell checker (Enchant/Hunspell). Press Backspace right after a correction to undo it; that word is then left alone. Never used in password, terminal, URL or e-mail fields.')));

        const smartGroup = new Adw.PreferencesGroup({ title: _('Smart Typing') });
        page.add(smartGroup);

        smartGroup.add(switchRow(settings, 'auto-capitalize',
            _('Auto-capitalization'),
            _('Capital letter at the start of a sentence'),
            _('Shift turns on by itself at the start of a sentence and of an empty field. It only affects letters. Tap Shift to type a small letter instead.')));
        smartGroup.add(switchRow(settings, 'double-space-period',
            _('Double-space for a period'),
            _('Tap space twice after a word to type a period and a space')));
        smartGroup.add(switchRow(settings, 'smart-auto-pairs',
            _('Close brackets and quotes'),
            _('Typing ( adds ) with the cursor in between'),
            _('Works for (), [], {} and "". If you type the closing character anyway, the cursor steps over the one already there.')));

        const longPressRow = expanderSwitch(settings, 'long-press',
            _('Hold for accents and symbols'),
            _('Tablet layout, and custom layouts made from it'),
            _('Hold a key to open a row of accented letters and symbols, slide to one and let go. The symbol in the corner of the key comes first.'));
        longPressRow.add_row(spinRow(settings, 'long-press-delay',
            _('Hold time (ms)'), _('How long to hold before the row appears'), 150, 900, 25));
        smartGroup.add(longPressRow);

        const keysGroup = new Adw.PreferencesGroup({ title: _('Keys') });
        page.add(keysGroup);

        keysGroup.add(switchRow(settings, 'play-sound',
            _('Click sound'), _('A soft click on each key press')));

        const repeatRow = new Adw.ExpanderRow({
            title: _('Key repeat and swipes'),
            subtitle: _('Held keys, space-bar cursor and Backspace selection'),
        });
        repeatRow.add_row(spinRow(settings, 'repeat-delay',
            _('Repeat delay (ms)'), _('How long a held key waits before repeating (default 320)'), 150, 800, 20));
        repeatRow.add_row(spinRow(settings, 'repeat-interval',
            _('Repeat interval (ms)'), _('Time between repeats (default 36)'), 15, 120, 5));
        repeatRow.add_row(spinRow(settings, 'space-slider-sensitivity',
            _('Space-bar swipe (px per character)'), _('Drag along the space bar to move the cursor'), 6, 40, 2));
        repeatRow.add_row(spinRow(settings, 'backspace-slider-sensitivity',
            _('Backspace swipe (px per character)'), _('Drag left from Backspace to select text to delete'), 8, 45, 2));
        keysGroup.add(repeatRow);

        return page;
    }

    // ==========================================
    // Page 2: Showing (when and where it appears)
    // ==========================================
    _buildShowingPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Showing'),
            icon_name: 'view-reveal-symbolic',
        });

        const openGroup = new Adw.PreferencesGroup({ title: _('Opening and Closing') });
        page.add(openGroup);

        const autoShowRow = expanderSwitch(settings, 'auto-show',
            _('Pop up on text fields'),
            _('Open when a text field is selected, hide when you leave it'),
            _('Also stops the stock GNOME on-screen keyboard from opening.'));
        autoShowRow.add_row(switchRow(settings, 'auto-show-touch-only',
            _('Only after touch'),
            _('Not when you reach the field with the keyboard, touchpad or mouse')));
        autoShowRow.add_row(switchRow(settings, 'hide-on-hardware-key',
            _('Hide on physical key'),
            _('Close when you type on the Type Cover or another keyboard')));
        openGroup.add(autoShowRow);

        openGroup.add(switchRow(settings, 'show-panel-button',
            _('Top bar button'), _('Keyboard icon in the top bar to open or close it')));

        const placeGroup = new Adw.PreferencesGroup({ title: _('Position and Size') });
        page.add(placeGroup);

        // Placement: one choice for the dock-bottom / dock-full-strip / full-strip-centered-keys trio,
        // the same cycle as the [Dock] and [Norm]/[Full] header buttons
        const placementRow = new Adw.ComboRow({
            title: _('Placement'),
            model: new Gtk.StringList({
                strings: [_('Floating'), _('Docked'), _('Docked, full width'), _('Docked, full width, keys centered')],
            }),
        });
        placementRow.add_suffix(infoButton(
            _('Floating: drag it anywhere on the screen. Docked: sits at the bottom edge. Full width: covers the whole bottom edge and moves windows up, so no text field is hidden behind it. The header buttons on the keyboard change this too.')));
        placeGroup.add(placementRow);

        const widthRow = spinRow(settings, 'width-percent',
            _('Width (%)'), _('Share of the screen width'), 40, 100, 5);
        placeGroup.add(widthRow);

        let placementSyncing = false;
        const syncPlacement = () => {
            const dock = settings.get_boolean('dock-bottom');
            const full = settings.get_boolean('dock-full-strip');
            const centered = settings.get_boolean('full-strip-centered-keys');
            const idx = !dock ? 0 : !full ? 1 : !centered ? 2 : 3;
            placementSyncing = true;
            if (placementRow.selected !== idx)
                placementRow.selected = idx;
            placementSyncing = false;
            // Full width without centered keys ignores the width setting
            widthRow.sensitive = idx !== 2;
        };
        syncPlacement();
        placementRow.connect('notify::selected', () => {
            if (placementSyncing)
                return;
            const idx = placementRow.selected;
            placementSyncing = true;
            settings.set_boolean('full-strip-centered-keys', idx === 3);
            settings.set_boolean('dock-full-strip', idx >= 2);
            settings.set_boolean('dock-bottom', idx >= 1);
            placementSyncing = false;
            syncPlacement();
        });
        for (const key of ['dock-bottom', 'dock-full-strip', 'full-strip-centered-keys']) {
            settings.connect(`changed::${key}`, () => {
                if (!placementSyncing)
                    syncPlacement();
            });
        }

        placeGroup.add(spinRow(settings, 'height-percent',
            _('Height (%)'), _('Share of the screen height. You can also drag the bar at the top of the keyboard'), 20, 55, 1));

        // Portrait height: 0 in the setting means "same as landscape"
        const portraitRow = new Adw.ExpanderRow({
            title: _('Separate height in portrait'),
            subtitle: _('When off, portrait uses the height above'),
            show_enable_switch: true,
        });
        const portraitSpin = new Adw.SpinRow({
            title: _('Portrait height (%)'),
            adjustment: new Gtk.Adjustment({ lower: 20, upper: 55, step_increment: 1 }),
        });
        portraitRow.add_row(portraitSpin);
        let portraitSyncing = false;
        const syncPortrait = () => {
            portraitSyncing = true;
            const v = settings.get_int('height-percent-portrait');
            portraitRow.enable_expansion = v > 0;
            portraitSpin.value = v > 0 ? v : settings.get_int('height-percent');
            portraitSyncing = false;
        };
        syncPortrait();
        portraitRow.expanded = false;
        portraitRow.connect('notify::enable-expansion', () => {
            if (portraitSyncing)
                return;
            settings.set_int('height-percent-portrait',
                portraitRow.enable_expansion ? Math.round(portraitSpin.value) : 0);
        });
        portraitSpin.connect('notify::value', () => {
            if (portraitSyncing || !portraitRow.enable_expansion)
                return;
            const v = Math.round(portraitSpin.value);
            if (settings.get_int('height-percent-portrait') !== v)
                settings.set_int('height-percent-portrait', v);
        });
        settings.connect('changed::height-percent-portrait', syncPortrait);
        settings.connect('changed::height-percent', () => {
            if (!portraitRow.enable_expansion)
                syncPortrait();
        });
        placeGroup.add(portraitRow);

        placeGroup.add(spinRow(settings, 'padding-bottom',
            _('Bottom padding (px)'), _('Space between the keys and the bottom edge'), 0, 60, 2));

        return page;
    }

    // ==========================================
    // Page 3: Look (layout, key style, font)
    // ==========================================
    _buildLookPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Look'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const layoutGroup = new Adw.PreferencesGroup({ title: _('Layout') });
        page.add(layoutGroup);

        // Layout in use
        const choices = LAYOUT_CHOICES.slice();
        if (settings.get_string('layout-variant') === 'it')
            choices.push(['it', 'Italian (Compact TKL)']);
        const layoutKeys = choices.map(c => c[0]);
        const layoutRow = new Adw.ComboRow({
            title: _('Layout'),
            model: new Gtk.StringList({ strings: choices.map(c => _(c[1])) }),
        });
        const syncLayoutRow = () => {
            const idx = layoutKeys.indexOf(settings.get_string('layout-variant'));
            const want = idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION;
            if (layoutRow.selected !== want)
                layoutRow.selected = want;
        };
        syncLayoutRow();
        layoutRow.connect('notify::selected', () => {
            const key = layoutKeys[layoutRow.selected];
            if (key && settings.get_string('layout-variant') !== key)
                settings.set_string('layout-variant', key);
        });
        settings.connect('changed::layout-variant', syncLayoutRow);
        layoutGroup.add(layoutRow);

        // Which layouts the layout button in the keyboard header cycles through.
        // Italian is not offered; if it is already in the list it is kept as is.
        const cycleRow = new Adw.ExpanderRow({
            title: _('Layout button cycles through'),
            subtitle: _('Tap the layout name at the top left of the keyboard to switch'),
        });
        const cycleKeys = LAYOUT_CHOICES.map(c => c[0]);
        const cycleSwitches = LAYOUT_CHOICES.map(([, name]) => {
            const row = new Adw.SwitchRow({ title: _(name) });
            cycleRow.add_row(row);
            return row;
        });
        let cycleSyncing = false;
        const syncCycle = () => {
            cycleSyncing = true;
            const chosen = settings.get_strv('layout-cycle');
            cycleSwitches.forEach((row, i) => {
                row.active = chosen.includes(cycleKeys[i]);
            });
            // The last layout left on cannot be switched off
            const total = chosen.length;
            cycleSwitches.forEach(row => {
                row.sensitive = !(row.active && total === 1);
            });
            cycleSyncing = false;
        };
        syncCycle();
        cycleSwitches.forEach(row => row.connect('notify::active', () => {
            if (cycleSyncing)
                return;
            const hidden = settings.get_strv('layout-cycle').filter(k => !cycleKeys.includes(k));
            const chosen = hidden.concat(cycleKeys.filter((k, i) => cycleSwitches[i].active));
            if (chosen.length === 0) {
                syncCycle();
                return;
            }
            settings.set_strv('layout-cycle', chosen);
        }));
        settings.connect('changed::layout-cycle', syncCycle);
        layoutGroup.add(cycleRow);

        // Layout Studio opens as a sub-page
        const studioRow = new Adw.ActionRow({
            title: _('Layout Studio'),
            subtitle: _('Edit the custom layout: labels, sizes, colours and key positions'),
            activatable: true,
        });
        studioRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        let studioPage = null;
        studioRow.connect('activated', () => {
            if (!studioPage)
                studioPage = this._buildLayoutStudioPage(window, settings);
            window.push_subpage(studioPage);
        });
        layoutGroup.add(studioRow);

        const keysGroup = new Adw.PreferencesGroup({ title: _('Keys') });
        page.add(keysGroup);

        const themeRow = new Adw.ComboRow({
            title: _('Key style'),
            subtitle: _('Fluent: Windows 11 look. Material: flat phone look that follows light or dark style'),
            model: new Gtk.StringList({ strings: [_('Fluent'), _('Material')] }),
        });
        const themeKeys = ['fluent', 'material'];
        const syncTheme = () => {
            const idx = Math.max(0, themeKeys.indexOf(settings.get_string('theme')));
            if (themeRow.selected !== idx)
                themeRow.selected = idx;
        };
        syncTheme();
        themeRow.connect('notify::selected', () => {
            const key = themeKeys[themeRow.selected] || 'fluent';
            if (settings.get_string('theme') !== key)
                settings.set_string('theme', key);
        });
        settings.connect('changed::theme', syncTheme);
        keysGroup.add(themeRow);

        // Font: one row, family picker + reset to the built-in legible font
        const fontRow = new Adw.ActionRow({ title: _('Font') });
        const fontBtn = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog(),
            level: Gtk.FontLevel.FAMILY,
            valign: Gtk.Align.CENTER,
        });
        const resetFontBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Back to the default font'),
        });
        // The default font is used only if it is installed; otherwise keys use the system font
        let defaultInstalled = false;
        try {
            defaultInstalled = PangoCairo.FontMap.get_default().list_families()
                .some(fam => fam.get_name() === DEFAULT_FONT);
        } catch (e) {}
        let shownDefault = DEFAULT_FONT;
        if (!defaultInstalled) {
            // Show the real family behind the 'Sans' alias so the button has a proper name
            shownDefault = 'Sans';
            try {
                const fontMap = PangoCairo.FontMap.get_default();
                const font = fontMap.load_font(fontMap.create_context(), Pango.FontDescription.from_string('Sans 12'));
                shownDefault = font.describe().get_family() || 'Sans';
            } catch (e) {}
        }
        let fontSyncing = false;
        const syncFont = () => {
            const f = (settings.get_string('font-family') || '').trim();
            fontSyncing = true;
            try {
                fontBtn.set_font_desc(Pango.FontDescription.from_string(`${f || shownDefault} 12`));
            } catch (e) {}
            fontSyncing = false;
            if (f)
                fontRow.subtitle = _('Custom font');
            else if (defaultInstalled)
                fontRow.subtitle = _('Default: Atkinson Hyperlegible Next, made for low vision and dyslexia');
            else
                fontRow.subtitle = _('Default: the system font. Install Atkinson Hyperlegible Next for the most legible keys');
            resetFontBtn.sensitive = !!f;
        };
        syncFont();
        fontBtn.connect('notify::font-desc', () => {
            if (fontSyncing)
                return;
            const desc = fontBtn.get_font_desc();
            const family = desc ? desc.get_family() : '';
            if (!family)
                return;
            const value = family === shownDefault ? '' : family;
            if (value !== settings.get_string('font-family'))
                settings.set_string('font-family', value);
        });
        resetFontBtn.connect('clicked', () => settings.set_string('font-family', ''));
        settings.connect('changed::font-family', syncFont);
        fontRow.add_suffix(fontBtn);
        fontRow.add_suffix(resetFontBtn);
        fontRow.activatable_widget = fontBtn;
        keysGroup.add(fontRow);

        keysGroup.add(spinRow(settings, 'font-scale',
            _('Text size (%)'), _('Labels shrink only if they do not fit the key'), 80, 160, 5));

        const spacingRow = new Adw.ExpanderRow({
            title: _('Spacing and corners'),
            subtitle: _('Gaps between keys and rows, corner rounding'),
        });
        spacingRow.add_row(spinRow(settings, 'key-gap-x',
            _('Gap between keys (px)'), '', 1, 16, 1));
        spacingRow.add_row(spinRow(settings, 'key-gap-y',
            _('Gap between rows (px)'), '', 1, 16, 1));
        spacingRow.add_row(spinRow(settings, 'number-row-gap',
            _('Extra gap below the number row (px)'), '', 2, 30, 2));
        spacingRow.add_row(spinRow(settings, 'key-radius',
            _('Corner radius (px)'), '', 0, 20, 1));
        keysGroup.add(spacingRow);

        const modColorsRow = new Adw.ExpanderRow({
            title: _('Modifier colours'),
            subtitle: _('Keys whose symbol changes with AltGr, Shift or FN (US TKL layout)'),
        });
        const modBgPicker = createColorPickerRow(
            _('Background'),
            _('Empty = the standard grey'),
            (colorStr) => settings.set_string('modified-key-bg-color', colorStr),
            () => {
                settings.set_string('modified-key-bg-color', '');
                modBgPicker.setColor('');
            }
        );
        modBgPicker.setColor(settings.get_string('modified-key-bg-color'));
        modColorsRow.add_row(modBgPicker.row);
        const modTextPicker = createColorPickerRow(
            _('Symbol'),
            _('Empty = the standard colour'),
            (colorStr) => settings.set_string('modified-key-text-color', colorStr),
            () => {
                settings.set_string('modified-key-text-color', '');
                modTextPicker.setColor('');
            }
        );
        modTextPicker.setColor(settings.get_string('modified-key-text-color'));
        modColorsRow.add_row(modTextPicker.row);
        keysGroup.add(modColorsRow);

        return page;
    }

    // ==========================================
    // Layout Studio (sub-page of Look)
    // ==========================================
    _buildLayoutStudioPage(window, settings) {
        const page3 = new Adw.PreferencesPage();
        const header = new Adw.HeaderBar();
        const toolbarView = new Adw.ToolbarView({ content: page3 });
        toolbarView.add_top_bar(header);
        const navPage = new Adw.NavigationPage({
            title: _('Layout Studio'),
            child: toolbarView,
        });

        const freshCopy = (key) => {
            const l = JSON.parse(JSON.stringify(Layouts[key]));
            l.name = 'Custom';
            return l;
        };
        let editingLayout = loadCustomLayout() || freshCopy('phone');
        let savedSnapshot = JSON.stringify(editingLayout);
        const isDirty = () => JSON.stringify(editingLayout) !== savedSnapshot;

        let selectedRowIdx = 0;
        let selectedKeyIdx = 0;

        // Save in the header bar, always in reach
        const saveBtn = new Gtk.Button({
            label: _('Save and Use'),
            css_classes: ['suggested-action'],
            tooltip_text: _('Save the custom layout and switch the keyboard to it'),
        });
        saveBtn.connect('clicked', () => {
            saveCustomLayout(editingLayout);
            savedSnapshot = JSON.stringify(editingLayout);
            settings.set_string('layout-variant', 'custom');
            // Bump token to trigger a live reload in keyboard.js
            const token = (settings.get_int('custom-layout-token') || 0) + 1;
            settings.set_int('custom-layout-token', token);
            window.add_toast(new Adw.Toast({ title: _('Custom layout saved and in use') }));
        });
        header.pack_end(saveBtn);

        // Start over from a built-in layout (asks first if there are unsaved edits)
        const actionsGroup = new Adw.PreferencesGroup({
            description: _('Tap a key in the preview, then change it below. Nothing reaches the keyboard until you press Save and Use.'),
        });
        page3.add(actionsGroup);

        const startFrom = (key) => {
            const apply = () => {
                editingLayout = freshCopy(key);
                selectedRowIdx = 0;
                selectedKeyIdx = 0;
                renderVisualKeyboard();
                updateInspector();
            };
            if (!isDirty()) {
                apply();
                return;
            }
            const dlg = new Adw.AlertDialog({
                heading: _('Discard unsaved changes?'),
                body: _('Starting over replaces the layout you are editing.'),
            });
            dlg.add_response('cancel', _('Cancel'));
            dlg.add_response('discard', _('Discard'));
            dlg.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.set_default_response('cancel');
            dlg.set_close_response('cancel');
            dlg.connect('response', (d, response) => {
                if (response === 'discard')
                    apply();
            });
            dlg.present(window);
        };
        const startRow = new Adw.ActionRow({
            title: _('Start over from'),
            subtitle: _('Tablet keeps its long-press symbols and corner hints'),
        });
        const startBox = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        for (const [key, label] of [['us', _('US')], ['phone', _('Tablet')]]) {
            const b = new Gtk.Button({ label });
            b.connect('clicked', () => startFrom(key));
            startBox.append(b);
        }
        startRow.add_suffix(startBox);
        actionsGroup.add(startRow);

        // Group 2: Anteprima Interattiva della Tastiera (Scrollable & Responsive)
        const previewGroup = new Adw.PreferencesGroup({
            title: _('Preview'),
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
            title: _('Selected Key'),
        });
        page3.add(inspectorGroup);

        // Label Entry
        const labelRow = new Adw.EntryRow({
            title: _('Label'),
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
            title: _('Width (key units)'),
            subtitle: _('1 is a letter key, 1.5 Tab, 6.5 Space'),
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
            title: _('Key code (evdev)'),
            subtitle: _('For example 16 is Q, 57 Space, 14 Backspace'),
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
            title: _('Behavior'),
            subtitle: _('On/off switch: toggles on each tap instead of repeating when held'),
            model: new Gtk.StringList({
                strings: [_('Normal'), _('On/off switch')]
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

        const moveLeftBtn = new Gtk.Button({ label: _('← Left') });
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

        const moveRightBtn = new Gtk.Button({ label: _('→ Right') });
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

        const moveUpBtn = new Gtk.Button({ label: _('↑ Row up') });
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

        const moveDownBtn = new Gtk.Button({ label: _('↓ Row down') });
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

        // Add / delete (delete can be undone from the toast)
        const editBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
        });
        const addKeyBtn = new Gtk.Button({ label: _('Add key after') });
        addKeyBtn.connect('clicked', () => {
            const targetRow = getCurrentRow();
            if (!targetRow)
                return;
            targetRow.splice(selectedKeyIdx + 1, 0, {
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
            });
            selectedKeyIdx++;
            renderVisualKeyboard();
            updateInspector();
        });
        editBox.append(addKeyBtn);

        const deleteKeyBtn = new Gtk.Button({
            label: _('Delete key'),
            css_classes: ['destructive-action'],
        });
        deleteKeyBtn.connect('clicked', () => {
            const row = getCurrentRow();
            if (!row || row.length <= 1)
                return;
            const layoutRef = editingLayout;
            const rIdx = selectedRowIdx;
            const kIdx = selectedKeyIdx;
            const [removed] = row.splice(kIdx, 1);
            selectedKeyIdx = Math.max(0, kIdx - 1);
            renderVisualKeyboard();
            updateInspector();
            const toast = new Adw.Toast({
                title: _('Key deleted: %s').replace('%s', removed.label || '?'),
                button_label: _('Undo'),
                timeout: 8,
            });
            toast.connect('button-clicked', () => {
                if (editingLayout !== layoutRef)
                    return;
                row.splice(kIdx, 0, removed);
                selectedRowIdx = rIdx;
                selectedKeyIdx = kIdx;
                renderVisualKeyboard();
                updateInspector();
            });
            window.add_toast(toast);
        });
        editBox.append(deleteKeyBtn);
        moveContainer.append(editBox);

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

        return navPage;
    }
}
