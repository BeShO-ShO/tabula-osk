// Pure helpers for the emoji panel (no Shell imports, so they can be unit-tested with plain gjs)
export const RECENT_MAX = 60;
const TAB_ICONS = {
    'Smileys & Emotion': '😀',
    'People & Body': '👋',
    'Animals & Nature': '🐻',
    'Food & Drink': '🍔',
    'Travel & Places': '🚗',
    'Activities': '⚽',
    'Objects': '💡',
    'Symbols': '🔣',
    'Flags': '🏁',
};

// emoji-data.txt: "Group name<TAB>emoji emoji ..." per line, '#' comments
export function parseEmojiData(text) {
    const groups = [];
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#'))
            continue;
        const tab = line.indexOf('\t');
        if (tab < 0)
            continue;
        const name = line.slice(0, tab);
        const list = line.slice(tab + 1).split(' ').filter(e => e);
        if (list.length)
            groups.push({ name, icon: TAB_ICONS[name] || list[0], list });
    }
    return groups;
}

// How many pages a list needs, and the slice shown on one page
export function pageCount(total, perPage) {
    return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}

export function pageSlice(list, page, perPage) {
    return list.slice(page * perPage, (page + 1) * perPage);
}

// Most recent first, no duplicates, capped
export function pushRecent(recent, emoji, max = RECENT_MAX) {
    return [emoji, ...recent.filter(e => e !== emoji)].slice(0, max);
}
