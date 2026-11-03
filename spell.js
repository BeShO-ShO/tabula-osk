import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Spell checking through Enchant's ispell-compatible pipe (`enchant-2 -a`), which uses the
// system Hunspell dictionaries. One long-running process; requests are answered in order.
// Words are only kept in memory (a small result cache) and are never logged.
export class SpellChecker {
    constructor(lang) {
        this._lang = lang;
        this._proc = null;
        this._in = null;
        this._out = null;
        this._queue = [];
        this._cache = new Map();
        this._failed = false;
        this._cancel = new Gio.Cancellable();
    }

    get available() {
        return !this._failed;
    }

    _start() {
        if (this._proc || this._failed)
            return !!this._proc;
        const bin = GLib.find_program_in_path('enchant-2');
        if (!bin) {
            this._failed = true;
            return false;
        }
        try {
            const argv = [bin, '-a'];
            if (this._lang)
                argv.push('-d', this._lang);
            this._proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            this._in = this._proc.get_stdin_pipe();
            this._out = new Gio.DataInputStream({ base_stream: this._proc.get_stdout_pipe() });
            this._proc.wait_async(null, () => {
                // Process ended (crash, missing dictionary): fail pending requests, allow one restart
                const pending = this._queue;
                this._queue = [];
                pending.forEach(p => p.resolve(null));
                const wasRunning = !!this._proc;
                this._proc = null;
                this._in = null;
                this._out = null;
                if (wasRunning && !this._destroyed) {
                    if (this._lang && !this._triedFallback) {
                        this._triedFallback = true;
                        this._lang = null;    // try Enchant's default dictionary
                    } else {
                        this._failed = true;
                    }
                }
            });
            this._banner = false;
            this._readLine();
            return true;
        } catch (e) {
            console.warn('[AproposOSK] spell checker unavailable:', e.message);
            this._failed = true;
            this._proc = null;
            return false;
        }
    }

    _readLine() {
        if (!this._out)
            return;
        const out = this._out;
        out.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                return;
            }
            if (line === null)
                return;
            this._onLine(line);
            if (this._out === out)
                this._readLine();
        });
    }

    _onLine(line) {
        if (!this._banner) {
            this._banner = true;     // "@(#) International Ispell ..."
            return;
        }
        const cur = this._queue[0];
        if (!cur)
            return;
        if (line === '') {
            // End of the answer for one input line
            this._queue.shift();
            this._finish(cur);
            return;
        }
        const c = line[0];
        if (c === '*' || c === '+' || c === '-') {
            cur.ok = true;
        } else if (c === '&') {
            const i = line.indexOf(':');
            cur.ok = false;
            cur.sugg = i >= 0 ? line.slice(i + 1).split(',').map(s => s.trim()).filter(Boolean) : [];
        } else if (c === '#') {
            cur.ok = false;
            cur.sugg = [];
        }
    }

    _finish(req) {
        const result = { ok: req.ok !== false, suggestions: req.sugg || [] };
        this._cache.set(req.word, result);
        if (this._cache.size > 400)
            this._cache.delete(this._cache.keys().next().value);
        req.resolve(result);
    }

    // Resolves to { ok, suggestions } or null when no checker is available.
    check(word) {
        if (!word || /[\s^]/.test(word))
            return Promise.resolve(null);
        const hit = this._cache.get(word);
        if (hit)
            return Promise.resolve(hit);
        if (!this._start())
            return Promise.resolve(null);
        return new Promise(resolve => {
            const req = { word, resolve, ok: undefined, sugg: null };
            this._queue.push(req);
            try {
                // '^' makes the line plain text, so words are never read as pipe commands
                const bytes = new TextEncoder().encode(`^${word}\n`);
                this._in.write_all(bytes, null);
                this._in.flush(null);
            } catch (e) {
                this._queue = this._queue.filter(q => q !== req);
                resolve(null);
            }
        });
    }

    destroy() {
        this._destroyed = true;
        this._cancel.cancel();
        const pending = this._queue;
        this._queue = [];
        pending.forEach(p => p.resolve(null));
        try {
            this._in?.close(null);
        } catch (e) {}
        try {
            this._proc?.force_exit();
        } catch (e) {}
        this._proc = null;
        this._in = null;
        this._out = null;
        this._cache.clear();
    }
}
