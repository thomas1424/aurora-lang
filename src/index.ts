// src/index.ts
import fs from 'fs';
import { tokenize } from './lexer';
import { Parser } from './parser';
import { generateJS } from './codegen';

function compileToJS(src: string) {
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  const ast = parser.parseProgram();
  const js = generateJS(ast);
  return js;
}

// CLI
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Aurora REPL (type .exit to quit). To run a file: aurora filename.aur');
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'aur> '});
  let buffer = '';
  rl.prompt();
  rl.on('line', (line: string) => {
    if (line.trim() === '.exit') { rl.close(); return; }
    buffer += line + '\n';
    if (line.trim() === '') {
      try {
        const js = compileToJS(buffer);
        // Here we run by using new Function so code runs under Node context
        new Function(js)();
      } catch (e: any) {
        console.error('Error:', e.message);
      }
      buffer = '';
    }
    rl.prompt();
  });
} else {
  const path = args[0];
  const src = fs.readFileSync(path, 'utf8');
  const js = compileToJS(src);
  // write temp file and run it under node - or simply eval in current process
  try {
    // run generated JS
    new Function(js)();
  } catch (e: any) {
    console.error('Runtime error:', e.message);
  }
}
