// One-time move from the extension's old name, Apropos OSK (apropos-osk@besho-sho).
// Copies the config folder (learned words, custom layout) and the dconf settings, only when
// the new ones do not exist yet, so it runs once and never overwrites anything.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const OLD_UUID = 'apropos-osk@besho-sho';
const OLD_DIR = 'apropos-osk';
const NEW_DIR = 'tabula-osk';
const OLD_PATH = '/org/gnome/shell/extensions/apropos-osk/';
const NEW_PATH = '/org/gnome/shell/extensions/tabula-osk/';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Learned words, learned word pairs and the custom layout. Synchronous: a few small files,
// and they must be in place before the keyboard loads them.
export function migrateConfigDir() {
    try {
        const cfg = GLib.get_user_config_dir();
        const oldDir = Gio.File.new_for_path(GLib.build_filenamev([cfg, OLD_DIR]));
        const newDir = Gio.File.new_for_path(GLib.build_filenamev([cfg, NEW_DIR]));
        if (!oldDir.query_exists(null) || newDir.query_exists(null))
            return false;
        newDir.make_directory_with_parents(null);
        const children = oldDir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = children.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            oldDir.get_child(name).copy(newDir.get_child(name), Gio.FileCopyFlags.NONE, null, null);
        }
        children.close(null);
        return true;
    } catch (e) {
        console.warn('[TabulaOSK] could not copy the Apropos OSK config folder:', e);
        return false;
    }
}

async function run(argv, input = null) {
    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE |
        (input !== null ? Gio.SubprocessFlags.STDIN_PIPE : Gio.SubprocessFlags.NONE);
    const proc = Gio.Subprocess.new(argv, flags);
    const [stdout] = await proc.communicate_utf8_async(input, null);
    return [proc.get_successful(), stdout ?? ''];
}

// The settings of the old schema, through the dconf tool (the old schema is gone once the
// old extension is removed, so Gio.Settings cannot read them). Only when this extension
// has no settings of its own yet, and never with another settings backend (tests).
export async function migrateSettings() {
    try {
        if (GLib.getenv('GSETTINGS_BACKEND'))
            return false;
        if (!GLib.find_program_in_path('dconf'))
            return false;
        const [okOld, oldDump] = await run(['dconf', 'dump', OLD_PATH]);
        if (!okOld || !oldDump.trim())
            return false;
        const [okNew, newDump] = await run(['dconf', 'dump', NEW_PATH]);
        if (!okNew || newDump.trim())
            return false;
        // Runtime state, not a preference: copying it could pop the keyboard open
        const keep = oldDump.split('\n').filter(l => !/^keyboard-visible=/.test(l)).join('\n');
        const [okLoad] = await run(['dconf', 'load', NEW_PATH], keep);
        return okLoad;
    } catch (e) {
        console.warn('[TabulaOSK] could not copy the Apropos OSK settings:', e);
        return false;
    }
}
