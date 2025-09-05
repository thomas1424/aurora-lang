"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const fs_1 = __importDefault(require("fs"));
const lexer_1 = require("./lexer");
const parser_1 = require("./parser");
const codegen_1 = require("./codegen");
function compileToJS(src) {
    const tokens = (0, lexer_1.tokenize)(src);
    const parser = new parser_1.Parser(tokens);
    const ast = parser.parseProgram();
    const js = (0, codegen_1.generateJS)(ast);
    return js;
}
// CLI
const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('Aurora REPL (type .exit to quit). To run a file: aurora filename.aur');
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'aur> ' });
    let buffer = '';
    rl.prompt();
    rl.on('line', (line) => {
        if (line.trim() === '.exit') {
            rl.close();
            return;
        }
        buffer += line + '\n';
        if (line.trim() === '') {
            try {
                const js = compileToJS(buffer);
                // Here we run by using new Function so code runs under Node context
                new Function(js)();
            }
            catch (e) {
                console.error('Error:', e.message);
            }
            buffer = '';
        }
        rl.prompt();
    });
}
else {
    const path = args[0];
    const src = fs_1.default.readFileSync(path, 'utf8');
    const js = compileToJS(src);
    // write temp file and run it under node - or simply eval in current process
    try {
        // run generated JS
        new Function(js)();
    }
    catch (e) {
        console.error('Runtime error:', e.message);
    }
}
