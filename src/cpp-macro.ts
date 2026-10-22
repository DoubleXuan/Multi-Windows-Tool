import { CodeRange, Position } from './protocol';

export interface MacroBody {
    name: string;
    identifiers: { name: string; range: CodeRange }[];
    truncated: boolean;
}
// Candidate tokenization only. The language service must resolve every edge.
// Splice continuations before lexing, retaining physical source coordinates.
export function scanMacro(text: string, line: number, limit = 200): MacroBody | undefined {
    const lines = text.split(/\r?\n/);
    if (!/^\s*#\s*define\s+/.test(lines[line] || '')) return;
    let directive = '';
    const positions: Position[] = [];
    for (let current = line; current < lines.length; current++) {
        const physical = lines[current];
        const continuation = /\\\s*$/.exec(physical);
        const end = continuation ? continuation.index : physical.length;
        for (let character = 0; character < end; character++) { directive += physical[character]; positions.push({ line: current, character }); }
        if (!continuation) break;
    }
    const header = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(directive);
    if (!header) return;
    let start = header[0].length;
    const parameters = new Set(['__VA_ARGS__', '__VA_OPT__']);
    if (directive[start] === '(') {
        let cursor = start + 1;
        while (cursor < directive.length && directive[cursor] !== ')') {
            if (directive.slice(cursor, cursor + 2) === '/*') {
                const end = directive.indexOf('*/', cursor + 2); if (end < 0) return; cursor = end + 2; continue;
            }
            if (directive.slice(cursor, cursor + 2) === '//') return;
            const parameter = /^[A-Za-z_]\w*/.exec(directive.slice(cursor));
            if (parameter) { parameters.add(parameter[0]); cursor += parameter[0].length; }
            else cursor++;
        }
        if (directive[cursor] !== ')') return;
        start = cursor + 1;
    }
    const identifiers: MacroBody['identifiers'] = [];
    let index = start;
    while (index < directive.length) {
        const char = directive[index], next = directive[index + 1];
        if (char === '/' && next === '/') break;
        if (char === '/' && next === '*') { const end = directive.indexOf('*/', index + 2); index = end < 0 ? directive.length : end + 2; continue; }
        const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(directive.slice(index));
        if (raw) {
            const endToken = `)${raw[1]}"`;
            const end = directive.indexOf(endToken, index + raw[0].length);
            index = end < 0 ? directive.length : end + endToken.length; continue;
        }
        const literal = /^(?:u8|u|U|L)?(["'])/.exec(directive.slice(index));
        if (literal) {
            const quote = literal[1]; index += literal[0].length;
            while (index < directive.length) {
                if (directive[index] === '\\') { index += 2; continue; }
                if (directive[index++] === quote) break;
            }
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            let end = index + 1;
            while (end < directive.length && /[A-Za-z_0-9]/.test(directive[end])) end++;
            const name = directive.slice(index, end);
            const before = directive.slice(start, index).trimEnd();
            const after = directive.slice(end).trimStart();
            if (!parameters.has(name) && !/[0-9]/.test(directive[index - 1] || '') && !before.endsWith('#') && !after.startsWith('##')) {
                if (identifiers.length >= limit) return { name: header[1], identifiers, truncated: true };
                const last = positions[end - 1];
                identifiers.push({ name, range: { start: positions[index], end: { line: last.line, character: last.character + 1 } } });
            }
            index = end; continue;
        }
        index++;
    }
    return { name: header[1], identifiers, truncated: false };
}
