"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenize = tokenize;
function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') { // single-line comment
            i += 2;
            while (i < src.length && src[i] !== '\n')
                i++;
            continue;
        }
        if (/[0-9]/.test(c)) {
            let n = c;
            i++;
            while (/[0-9.]/.test(src[i])) {
                n += src[i];
                i++;
            }
            tokens.push({ type: 'NUMBER', text: n });
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = c;
            i++;
            let s = '';
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\') {
                    i++;
                    if (i < src.length) {
                        s += src[i];
                        i++;
                    }
                }
                else {
                    s += src[i++];
                }
            }
            i++; // skip quote
            tokens.push({ type: 'STRING', text: s });
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let id = c;
            i++;
            while (/[A-Za-z0-9_]/.test(src[i])) {
                id += src[i++];
            }
            const kw = ['let', 'fun', 'if', 'else', 'return', 'true', 'false', 'null', 'while', 'for', 'print'].includes(id) ? id.toUpperCase() : 'IDENT';
            tokens.push({ type: kw, text: id });
            continue;
        }
        // operators and punctuation
        const two = src.substr(i, 2);
        if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
            tokens.push({ type: two, text: two });
            i += 2;
            continue;
        }
        tokens.push({ type: c, text: c });
        i++;
    }
    tokens.push({ type: 'EOF', text: '' });
    return tokens;
}
