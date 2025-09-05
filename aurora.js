#!/usr/bin/env node
/*
AuroraLang v2 — Enhanced single-file interpreter (aurora.js)

Huge upgrade from the original toy language. Additions in v2:
- Line/column tracking in the lexer and much improved error messages
- Module loader: built-in `require()` for .aur modules or npm packages, with caching
- Try / Catch / Throw
- Class declarations + `new` operator and `this` binding
- `import` as a convenience alias to `require` (runtime-supported)
- Builtins: fs (read/write/exists), os (cwd, homedir, env), httpGet (simple GET), exec (spawn), json parse/stringify
- REPL improvements: history, .load, .help, .exit, multi-line buffer executed with `;;`
- Better runtime stdlib: range, len, type, keys, values, push, pop, join, requireNpm
- More robust parser and some extra operators

Usage:
  node aurora.js              # REPL
  node aurora.js file.aur     # Run script

Notes:
- This is still an interpreted language implemented in a single JS file. It's designed to be easy to extend.
- Module paths in require() that are relative (./ or ../) are resolved from the working directory of the running process.


*/

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const child_process = require('child_process');
const https = require('https');

// -------------------- Lexer (with line/col) --------------------
class Lexer {
  constructor(source, filename = '<input>') {
    this.src = source;
    this.i = 0;
    this.line = 1;
    this.col = 0;
    this.tokens = [];
    this.filename = filename;
  }
  isAtEnd() { return this.i >= this.src.length; }
  peek() { return this.src[this.i] || '\0'; }
  advance() {
    const ch = this.src[this.i++] || '\0';
    if (ch === '\n') { this.line++; this.col = 0; }
    else this.col++;
    return ch;
  }
  add(type, lexeme, literal=null, line=null, col=null) {
    this.tokens.push({type, lexeme, literal, line: line ?? this.line, col: col ?? this.col, file: this.filename});
  }
  lex() {
    while (!this.isAtEnd()) {
      let startLine = this.line, startCol = this.col+1; // columns 1-based
      const c = this.advance();
      if (/\s/.test(c)) { continue; }
      // comments
      if (c === '/' && this.peek() === '/') {
        while (!this.isAtEnd() && this.peek() !== '\n') this.advance();
        continue;
      }
      if (c === '/' && this.peek() === '*') {
        this.advance();
        while (!this.isAtEnd()) {
          if (this.peek() === '*' && this.src[this.i+1] === '/') { this.advance(); this.advance(); break; }
          this.advance();
        }
        continue;
      }
      // identifiers / keywords
      if (/[A-Za-z_]/.test(c)) {
        let s = c;
        while (/[A-Za-z0-9_]/.test(this.peek())) s += this.advance();
        const kw = keywords[s];
        if (kw) this.add(kw, s, s, startLine, startCol);
        else this.add('IDENT', s, s, startLine, startCol);
        continue;
      }
      // numbers
      if (/[0-9]/.test(c)) {
        let s = c;
        while (/[0-9]/.test(this.peek())) s += this.advance();
        if (this.peek() === '.' && /[0-9]/.test(this.src[this.i+1])) {
          s += this.advance();
          while (/[0-9]/.test(this.peek())) s += this.advance();
        }
        this.add('NUMBER', s, Number(s), startLine, startCol);
        continue;
      }
      // strings
      if (c === '"' || c === "'") {
        const quote = c;
        let s = '';
        while (!this.isAtEnd() && this.peek() !== quote) {
          if (this.peek() === '\\') {
            this.advance();
            const esc = this.advance();
            const map = { 'n':'\\n', 't':'\\t', 'r':'\\r', '\\':'\\\\', '"':'"', "'":"'" };
            s += map[esc] ?? esc;
          } else {
            s += this.advance();
          }
        }
        if (this.peek() !== quote) throw this.lexError('Unterminated string', startLine, startCol);
        this.advance();
        this.add('STRING', s, s, startLine, startCol);
        continue;
      }
      // two-char operators
      const two = c + this.peek();
      if (['==','!=','<=','>=','&&','||','**'].includes(two)) { this.advance(); this.add(two, two, null, startLine, startCol); continue; }
      // single char tokens
      const singles = '(){}[],;:.+-*/%<>=!~?';
      if (singles.includes(c)) { this.add(c, c, null, startLine, startCol); continue; }
      throw this.lexError('Unexpected character: ' + c, startLine, startCol);
    }
    this.add('EOF', '', null, this.line, this.col);
    return this.tokens;
  }
  lexError(msg, line, col) { const e = new SyntaxError(`${msg} at ${this.filename}:${line}:${col}`); e.line=line; e.col=col; throw e; }
}

const keywords = {
  'let':'LET', 'const':'CONST', 'fun':'FUN', 'return':'RETURN', 'if':'IF', 'else':'ELSE', 'while':'WHILE', 'for':'FOR',
  'true':'TRUE', 'false':'FALSE', 'null':'NULL', 'break':'BREAK', 'continue':'CONTINUE', 'class':'CLASS', 'new':'NEW',
  'try':'TRY', 'catch':'CATCH', 'throw':'THROW', 'import':'IMPORT', 'export':'EXPORT', 'this':'THIS'
};

function lex(source, filename) { return new Lexer(source, filename).lex(); }

// -------------------- Parser --------------------
class Parser {
  constructor(tokens) { this.toks = tokens; this.i = 0; }
  peek() { return this.toks[this.i]; }
  check(type) { return this.peek().type === type; }
  match(...types) { if (types.some(t=>this.check(t))) { return this.toks[this.i++]; } return null; }
  consume(type, msg) { if (this.check(type)) return this.toks[this.i++]; throw this.parseError(msg + ` (got ${this.peek().type})`, this.peek()); }
  parseError(msg, token) { const e = new SyntaxError(msg + ` at ${token.file}:${token.line}:${token.col}`); e.token=token; throw e; }

  parseProgram() {
    const decls = [];
    while (!this.check('EOF')) decls.push(this.declaration());
    return { type:'Program', body: decls };
  }

  declaration() {
    if (this.match('FUN')) return this.functionDecl(true);
    if (this.check('LET') || this.check('CONST')) return this.varDecl();
    if (this.match('CLASS')) return this.classDecl();
    if (this.match('IMPORT')) return this.importStmt();
    return this.statement();
  }

  importStmt() {
    // syntax: import "file"; or import IDENT from "file"; -> returns VarDecl form recommended
    const tok = this.peek();
    if (this.check('STRING')) {
      const pathToken = this.consume('STRING','Expected string after import');
      this.match(';');
      return { type:'Import', path: pathToken.literal };
    }
    if (this.check('IDENT')) {
      const local = this.consume('IDENT').lexeme || this.toks[this.i-1].lexeme;
      if (this.match('FROM')) {
        const fileTok = this.consume('STRING','Expected string after from'); this.match(';');
        return { type:'ImportNamed', local, path: fileTok.literal };
      }
      throw this.parseError('Invalid import syntax', this.peek());
    }
    throw this.parseError('Invalid import syntax', this.peek());
  }

  classDecl() {
    const nameTok = this.consume('IDENT','Expected class name');
    const methods = [];
    this.consume('{','Expected { after class name');
    while (!this.check('}')) {
      // method: IDENT '(' params ')' block
      const methodName = this.consume('IDENT','Expected method name').lexeme;
      this.consume('(','Expected ( after method name');
      const params = [];
      if (!this.check(')')) { do { params.push(this.consume('IDENT','Expected parameter').lexeme); } while (this.match(',')); }
      this.consume(')','Expected ) after params');
      const body = this.block();
      methods.push({ name: methodName, params, body });
    }
    this.consume('}','Expected } after class body');
    return { type:'ClassDecl', name: nameTok.lexeme, methods };
  }

  functionDecl(requireName) {
    let name = null;
    if (!this.check('(') && this.check('IDENT')) name = this.consume('IDENT','Expected function name').lexeme;
    this.consume('(','Expected ( after function name');
    const params = [];
    if (!this.check(')')) {
      do { params.push(this.consume('IDENT','Expected parameter name').lexeme); } while (this.match(','));
    }
    this.consume(')','Expected ) after parameters');
    const body = this.block();
    return { type:'FunctionDecl', name, params, body };
  }

  varDecl() {
    const kindTok = this.toks[this.i++]; // LET or CONST
    const kind = kindTok.type;
    const nameTok = this.consume('IDENT','Expected variable name');
    let init = null;
    if (this.match('=')) init = this.expression();
    this.match(';');
    return { type:'VarDecl', kind, name: nameTok.lexeme, init };
  }

  statement() {
    if (this.match('{')) return this.finishBlock();
    if (this.match('IF')) return this.ifStatement();
    if (this.match('WHILE')) return this.whileStatement();
    if (this.match('FOR')) return this.forStatement();
    if (this.match('RETURN')) return this.returnStatement();
    if (this.match('TRY')) return this.tryStatement();
    if (this.match('THROW')) return this.throwStatement();
    return this.exprStmt();
  }

  tryStatement() {
    const tryBlock = this.block();
    let catchParam = null, catchBlock = null;
    if (this.match('CATCH')) {
      this.consume('(','Expected ( after catch');
      catchParam = this.consume('IDENT','Expected catch parameter').lexeme;
      this.consume(')','Expected ) after catch param');
      catchBlock = this.block();
    }
    return { type:'TryCatch', tryBlock, catchParam, catchBlock };
  }

  throwStatement() {
    const expr = this.expression(); this.match(';');
    return { type:'Throw', expr };
  }

  block() { this.consume('{','Expected { to start block'); return this.finishBlock(); }
  finishBlock() {
    const body = [];
    while (!this.check('}') && !this.check('EOF')) body.push(this.declaration());
    this.consume('}','Expected } after block');
    return { type:'Block', body };
  }

  ifStatement() {
    this.consume('(','Expected ( after if');
    const test = this.expression();
    this.consume(')','Expected ) after condition');
    const consequent = this.statement();
    let alternate = null;
    if (this.match('ELSE')) alternate = this.statement();
    return { type:'If', test, consequent, alternate };
  }

  whileStatement() {
    this.consume('(','Expected ( after while');
    const test = this.expression();
    this.consume(')','Expected ) after condition');
    const body = this.statement();
    return { type:'While', test, body };
  }

  forStatement() {
    this.consume('(','Expected ( after for');
    let init = null;
    if (this.check(';')) { this.i++; }
    else if (this.check('LET') || this.check('CONST')) init = this.varDecl();
    else init = this.exprStmt();

    let test = null; if (!this.check(';')) test = this.expression(); this.consume(';','Expected ; after loop condition');
    let update = null; if (!this.check(')')) update = this.expression(); this.consume(')','Expected ) after for clauses');
    const body = this.statement();
    return { type:'For', init, test, update, body };
  }

  returnStatement() {
    let argument = null;
    if (!this.check(';') && !this.check('}') && !this.check('EOF')) argument = this.expression();
    this.match(';');
    return { type:'Return', argument };
  }

  exprStmt() {
    const expr = this.expression();
    this.match(';');
    return { type:'ExprStmt', expression: expr };
  }

  expression() { return this.assignment(); }

  assignment() {
    const left = this.logicOr();
    if (this.match('=')) {
      const value = this.assignment();
      return { type:'Assign', target:left, value };
    }
    return left;
  }

  logicOr() {
    let expr = this.logicAnd();
    while (this.match('||')) { const right = this.logicAnd(); expr = { type:'Logical', op:'||', left:expr, right }; }
    return expr;
  }
  logicAnd() {
    let expr = this.equality();
    while (this.match('&&')) { const right = this.equality(); expr = { type:'Logical', op:'&&', left:expr, right }; }
    return expr;
  }
  equality() {
    let expr = this.comparison();
    while (this.match('==','!=')) { const op=this.toks[this.i-1].type; const right=this.comparison(); expr={type:'Binary',op,left:expr,right}; }
    return expr;
  }
  comparison() {
    let expr = this.term();
    while (this.match('>','>=','<','<=')) { const op=this.toks[this.i-1].type; const right=this.term(); expr={type:'Binary',op,left:expr,right}; }
    return expr;
  }
  term() {
    let expr = this.factor();
    while (this.match('+','-')) { const op=this.toks[this.i-1].type; const right=this.factor(); expr={type:'Binary',op,left:expr,right}; }
    return expr;
  }
  factor() {
    let expr = this.power();
    while (this.match('*','/','%')) { const op=this.toks[this.i-1].type; const right=this.power(); expr={type:'Binary',op,left:expr,right}; }
    return expr;
  }
  power() {
    let expr = this.unary();
    while (this.match('**')) { const right=this.unary(); expr={type:'Binary',op:'**',left:expr,right}; }
    return expr;
  }
  unary() {
    if (this.match('!','-')) { const op=this.toks[this.i-1].type; const right=this.unary(); return {type:'Unary',op,right}; }
    if (this.match('NEW')) { const callee = this.call(); return { type:'New', callee }; }
    return this.call();
  }
  call() {
    let expr = this.primary();
    while (true) {
      if (this.match('(')) {
        const args = [];
        if (!this.check(')')) { do { args.push(this.expression()); } while (this.match(',')); }
        this.consume(')','Expected ) after arguments');
        expr = { type:'Call', callee:expr, args };
      } else if (this.match('[')) {
        const index = this.expression();
        this.consume(']','Expected ] after index');
        expr = { type:'Index', object:expr, index };
      } else if (this.match('.')) {
        const nameTok = this.consume('IDENT','Expected property name after .');
        expr = { type:'Property', object:expr, name: nameTok.lexeme };
      } else break;
    }
    return expr;
  }
  primary() {
    if (this.match('NUMBER')) return { type:'Literal', value:this.toks[this.i-1].literal };
    if (this.match('STRING')) return { type:'Literal', value:this.toks[this.i-1].literal };
    if (this.match('TRUE')) return { type:'Literal', value:true };
    if (this.match('FALSE')) return { type:'Literal', value:false };
    if (this.match('NULL')) return { type:'Literal', value:null };
    if (this.match('THIS')) return { type:'This' };
    if (this.match('IDENT')) return { type:'Identifier', name:this.toks[this.i-1].lexeme };
    if (this.match('(')) { const e=this.expression(); this.consume(')','Expected )'); return e; }
    if (this.match('[')) {
      const elements=[]; if (!this.check(']')) { do { elements.push(this.expression()); } while (this.match(',')); }
      this.consume(']','Expected ] after array'); return { type:'Array', elements };
    }
    if (this.match('{')) {
      const props=[]; if (!this.check('}')) { do {
        let keyToken;
        if (this.check('IDENT')||this.check('STRING')) keyToken=this.toks[this.i++]; else throw this.parseError('Expected key in object literal', this.peek());
        const key = keyToken.type==='IDENT' ? keyToken.lexeme : keyToken.literal;
        this.consume(':','Expected : after key');
        const value = this.expression();
        props.push({key, value});
      } while (this.match(',')); }
      this.consume('}','Expected } after object'); return { type:'Object', props };
    }
    if (this.match('FUN')) { // anonymous function
      let name=null; if (!this.check('(') && this.check('IDENT')) name = this.consume('IDENT').lexeme;
      this.consume('(','Expected (');
      const params=[]; if (!this.check(')')) { do { params.push(this.consume('IDENT','Expected parameter').lexeme); } while (this.match(',')); }
      this.consume(')','Expected )');
      const body=this.block();
      return { type:'FunctionExpr', name, params, body };
    }
    throw this.parseError('Unexpected token: ' + this.peek().type, this.peek());
  }
}

// -------------------- Interpreter --------------------
class ReturnSignal { constructor(value){ this.value=value; } }
class BreakSignal { constructor(){} }
class ContinueSignal { constructor(){} }

class Env {
  constructor(parent=null) { this.map = Object.create(null); this.consts = new Set(); this.parent = parent; }
  define(name, value, isConst=false) { if (name in this.map) throw runtimeError(`Variable already declared: ${name}`); this.map[name]=value; if (isConst) this.consts.add(name); }
  assign(name, value) {
    if (name in this.map) { if (this.consts.has(name)) throw runtimeError(`Cannot reassign const ${name}`); this.map[name]=value; return; }
    if (this.parent) return this.parent.assign(name,value);
    throw runtimeError(`Undefined variable ${name}`);
  }
  get(name) { if (name in this.map) return this.map[name]; if (this.parent) return this.parent.get(name); throw runtimeError(`Undefined variable ${name}`); }
}

class AuroraFunction {
  constructor(name, params, body, closure, isMethod = false) { this.name=name; this.params=params; this.body=body; this.closure=closure; this.isMethod=isMethod; }
  call(interp, args, thisArg = null) {
    if (args.length !== this.params.length) throw runtimeError(`Expected ${this.params.length} args, got ${args.length}`);
    const env = new Env(this.closure);
    if (thisArg !== null) env.define('this', thisArg, true);
    for (let i=0;i<this.params.length;i++) env.define(this.params[i], args[i]);
    try { return interp.execBlock(this.body.body, env, true); } catch (e) { if (e instanceof ReturnSignal) return e.value; if (e instanceof BreakSignal) throw e; throw e; }
  }
  toString() { return `<fun ${this.name||'<anon>'}>`; }
}

class AuroraClass {
  constructor(name, methods, closure) { this.name=name; this.methods = methods; this.closure = closure; }
  construct(interp, args) {
    // instance object
    const inst = {};
    // add methods bound to instance
    for (const m of this.methods) {
      const fn = new AuroraFunction(m.name, m.params, m.body, this.closure, true);
      // method wrapper that passes thisArg
      inst[m.name] = { call: (i, a) => fn.call(interp, a, inst), toString(){ return `<method ${m.name}>`; } };
    }
    // call constructor if exists
    if (inst['constructor']) {
      inst['constructor'].call(interp, args);
    }
    return inst;
  }
  toString() { return `<class ${this.name}>`; }
}

class Interpreter {
  constructor() {
    this.global = new Env();
    this.moduleCache = new Map(); // absolutePath -> exports
    this.setupBuiltins();
  }

  setupBuiltins() {
    this.global.define('print', {call: (i, args) => { console.log(...args.map(v=>repr(v))); return null; }, toString(){return '<builtin print>';}});
    this.global.define('len',   {call: (i, args) => { if(args.length!==1) throw runtimeError('len expects 1 arg'); const v=args[0]; if (typeof v==='string'||Array.isArray(v)) return v.length; if (v && typeof v==='object') return Object.keys(v).length; throw runtimeError('len expects string/array/object'); }});
    this.global.define('type',  {call: (i, args) => { if(args.length!==1) throw runtimeError('type expects 1 arg'); return jstype(args[0]); }});
    this.global.define('clock', {call: () => Date.now()/1000});
    this.global.define('range', {call: (i, args)=> rangeBuiltin(args)});
    this.global.define('keys',  {call: (i, args)=> { if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])) throw runtimeError('keys expects object'); return Object.keys(args[0]); }});
    this.global.define('values',{call: (i, args)=> { if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])) throw runtimeError('values expects object'); return Object.values(args[0]); }});
    this.global.define('push',  {call: (i, args)=> { if(args.length<2||!Array.isArray(args[0])) throw runtimeError('push(arr, item)'); args[0].push(...args.slice(1)); return args[0].length; }});
    this.global.define('pop',   {call: (i, args)=> { if(args.length!==1||!Array.isArray(args[0])) throw runtimeError('pop(arr)'); return args[0].pop(); }});
    this.global.define('join',  {call: (i, args)=> { if(args.length<1||!Array.isArray(args[0])) throw runtimeError('join(arr, sep?)'); const sep = args[1]===undefined? ',': String(args[1]); return args[0].join(sep); }});

    // fs helpers
    this.global.define('fs_read', {call: (i,args)=>{ if(args.length!==1) throw runtimeError('fs_read(path)'); return fs.readFileSync(String(args[0]), 'utf8'); }});
    this.global.define('fs_write', {call: (i,args)=>{ if(args.length<2) throw runtimeError('fs_write(path, data)'); fs.writeFileSync(String(args[0]), String(args[1])); return null; }});
    this.global.define('fs_exists', {call: (i,args)=>{ if(args.length!==1) throw runtimeError('fs_exists(path)'); return fs.existsSync(String(args[0])); }});

    // os / env
    this.global.define('cwd', {call: ()=> process.cwd()});
    this.global.define('homedir', {call: ()=> require('os').homedir()});
    this.global.define('env', process.env);

    // simple http GET (promise-like; will block until complete using sync wait — but implemented via callback returning string in this sync interpreter)
    this.global.define('httpGet', {call: (i,args)=>{ if(args.length<1) throw runtimeError('httpGet(url)'); const url = String(args[0]); return httpGetSync(url); }});

    // exec
    this.global.define('exec', {call: (i,args)=>{ if(args.length<1) throw runtimeError('exec(cmd)'); return child_process.execSync(args[0], { encoding: 'utf8' }); }});

    // require for modules (aurora or npm)
    this.global.define('require', {call: (i,args)=>{ if(args.length<1) throw runtimeError('require(module)'); return this.requireModule(String(args[0])); }});
    this.global.define('requireNpm', {call: (i,args)=>{ if(args.length<1) throw runtimeError('requireNpm(name)'); return require(String(args[0])); }});

    // alias import to require
    this.global.define('import', {call: (i,args)=>{ if(args.length<1) throw runtimeError('import(path)'); return this.requireModule(String(args[0])); }});
  }

  requireModule(spec) {
    // if spec starts with ./ or / or ../ treat as aurora file
    try {
      if (spec.startsWith('./') || spec.startsWith('/') || spec.startsWith('../')) {
        const abs = path.resolve(process.cwd(), spec);
        if (this.moduleCache.has(abs)) return this.moduleCache.get(abs);
        const src = fs.readFileSync(abs, 'utf8');
        const tokens = lex(src, abs);
        const ast = new Parser(tokens).parseProgram();
        const moduleEnv = new Env(this.global);
        moduleEnv.define('exports', {} , true);
        moduleEnv.define('module', { exports: moduleEnv.get('exports') }, true);
        // run file
        this.execBlock(ast.body, moduleEnv);
        const exported = moduleEnv.get('module').exports;
        this.moduleCache.set(abs, exported);
        return exported;
      } else {
        // try node modules first
        return require(spec);
      }
    } catch (e) {
      throw runtimeError('Error loading module ' + spec + ': ' + e.message);
    }
  }

  eval(node, env=this.global) {
    switch (node.type) {
      case 'Program': {
        let last=null; for (const d of node.body) last=this.eval(d, env); return last;
      }
      case 'Block': return this.execBlock(node.body, new Env(env));
      case 'VarDecl': {
        const value = node.init ? this.eval(node.init, env) : null;
        env.define(node.name, value, node.kind==='CONST');
        return value;
      }
      case 'FunctionDecl': {
        const fn = new AuroraFunction(node.name, node.params, node.body, env);
        if (node.name) env.define(node.name, fn, true);
        return fn;
      }
      case 'ClassDecl': {
        const cls = new AuroraClass(node.name, node.methods, env);
        env.define(node.name, cls, true);
        return cls;
      }
      case 'Import': {
        return this.requireModule(node.path);
      }
      case 'ImportNamed': {
        const m = this.requireModule(node.path); env.define(node.local, m, true); return m;
      }
      case 'ExprStmt': return this.eval(node.expression, env);
      case 'If': {
        if (truthy(this.eval(node.test, env))) return this.eval(node.consequent, env);
        else if (node.alternate) return this.eval(node.alternate, env);
        return null;
      }
      case 'While': {
        let result=null; while (truthy(this.eval(node.test, env))) result=this.eval(node.body, env); return result;
      }
      case 'For': {
        const loopEnv = new Env(env);
        if (node.init) this.eval(node.init, loopEnv);
        let result=null;
        while (node.test? truthy(this.eval(node.test, loopEnv)) : true) {
          result = this.eval(node.body, loopEnv);
          if (node.update) this.eval(node.update, loopEnv);
        }
        return result;
      }
      case 'TryCatch': {
        try {
          return this.eval(node.tryBlock, env);
        } catch (e) {
          if (node.catchBlock) {
            const catchEnv = new Env(env);
            if (node.catchParam) catchEnv.define(node.catchParam, e, false);
            return this.eval(node.catchBlock, catchEnv);
          }
          throw e;
        }
      }
      case 'Return': {
        const val = node.argument ? this.eval(node.argument, env) : null; throw new ReturnSignal(val);
      }
      case 'Throw': {
        const v = this.eval(node.expr, env); throw v instanceof Error ? v : new Error(String(v));
      }
      case 'Assign': return this.assign(node.target, node.value, env);
      case 'Logical': {
        const left = this.eval(node.left, env);
        if (node.op==='||') return truthy(left) ? left : this.eval(node.right, env);
        if (node.op==='&&') return !truthy(left) ? left : this.eval(node.right, env);
      }
      case 'Binary': {
        const l=this.eval(node.left, env), r=this.eval(node.right, env); switch(node.op){
          case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return l / r; case '%': return l % r; case '**': return l ** r;
          case '==': return eq(l,r); case '!=': return !eq(l,r);
          case '>': return l>r; case '>=': return l>=r; case '<': return l<r; case '<=': return l<=r;
        } throw runtimeError('Unknown binary op ' + node.op);
      }
      case 'Unary': { const v=this.eval(node.right, env); switch(node.op){ case '!': return !truthy(v); case '-': return -v; default: throw runtimeError('Unknown unary op'); } }
      case 'Literal': return node.value;
      case 'Identifier': return env.get(node.name);
      case 'This': return env.get('this');
      case 'Array': return node.elements.map(e=>this.eval(e, env));
      case 'Object': { const o={}; for (const {key,value} of node.props) o[key]=this.eval(value, env); return o; }
      case 'Property': {
        const obj = this.eval(node.object, env);
        if (obj==null || typeof obj!=='object') throw runtimeError('Cannot access property of non-object');
        return obj[node.name];
      }
      case 'Index': {
        const obj=this.eval(node.object, env); const idx=this.eval(node.index, env);
        if ((typeof obj!=='object' && !Array.isArray(obj) && typeof obj!=='string') || obj==null) throw runtimeError('Indexing non-indexable');
        return obj[idx];
      }
      case 'Call': {
        // special handling for property calls to set thisArg
        if (node.callee.type === 'Property') {
          const obj = this.eval(node.callee.object, env);
          const method = obj[node.callee.name];
          const args = node.args.map(a=>this.eval(a, env));
          if (method instanceof AuroraFunction) return method.call(this, args, obj);
          if (method && typeof method.call === 'function') return method.call(this, args);
          throw runtimeError('Not callable: ' + repr(method));
        }
        const callee = this.eval(node.callee, env);
        const args = node.args.map(a=>this.eval(a, env));
        if (callee instanceof AuroraFunction) return callee.call(this, args);
        if (callee instanceof AuroraClass) return callee.construct(this, args);
        if (callee && typeof callee.call === 'function') return callee.call(this, args);
        throw runtimeError('Not callable: ' + repr(callee));
      }
      case 'New': {
        // callee should evaluate to a class or constructor-like value
        const callee = this.eval(node.callee, env);
        const args = node.args ? node.args.map(a=>this.eval(a, env)) : [];
        if (callee instanceof AuroraClass) return callee.construct(this, args);
        if (callee && typeof callee.call === 'function') {
          // treat as constructor factory
          return callee.call(this, args);
        }
        throw runtimeError('Not constructable: ' + repr(callee));
      }
      case 'FunctionExpr': {
        const fn = new AuroraFunction(node.name, node.params, node.body, env);
        if (node.name) env.define(node.name, fn, true);
        return fn;
      }
      default: throw runtimeError('Unknown AST node ' + node.type);
    }
  }

  execBlock(stmts, env, isFunctionBody=false) {
    let last=null; for (const s of stmts) last = this.eval(s, env); return last;
  }

  assign(target, valueNode, env) {
    if (target.type==='Identifier') { const val=this.eval(valueNode, env); env.assign(target.name, val); return val; }
    if (target.type==='Property') {
      const obj=this.eval(target.object, env); if (!obj || typeof obj!=='object') throw runtimeError('Cannot set property on non-object');
      const val=this.eval(valueNode, env); obj[target.name]=val; return val;
    }
    if (target.type==='Index') {
      const obj=this.eval(target.object, env); const idx=this.eval(target.index, env);
      if (obj==null || (typeof obj!=='object' && !Array.isArray(obj) && typeof obj!=='string')) throw runtimeError('Cannot index into non-indexable');
      const val=this.eval(valueNode, env); obj[idx]=val; return val;
    }
    throw runtimeError('Invalid assignment target');
  }
}

function truthy(v){ return !!v; }
function eq(a,b){
  if (typeof a!==typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length!==b.length) return false; for (let i=0;i<a.length;i++) if (!eq(a[i],b[i])) return false; return true; }
  if (a && typeof a==='object' && b && typeof b==='object') {
    const ka=Object.keys(a), kb=Object.keys(b); if (ka.length!==kb.length) return false; for (const k of ka) if (!eq(a[k], b[k])) return false; return true;
  }
  return a===b;
}
function jstype(v){ if (v===null) return 'null'; if (Array.isArray(v)) return 'array'; return typeof v; }
function repr(v){
  if (v instanceof AuroraFunction) return v.toString();
  if (v instanceof AuroraClass) return v.toString();
  if (v === null) return 'null';
  if (typeof v==='string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (typeof v==='object') return '{' + Object.entries(v).map(([k,val])=>k+': '+repr(val)).join(', ') + '}';
  return String(v);
}
function runtimeError(msg) { const e = new Error('RuntimeError: ' + msg); e.isRuntime = true; throw e; }

function rangeBuiltin(args){
  let start, end, step;
  if (args.length===1) { start=0; end=Number(args[0]); step=1; }
  else if (args.length===2) { start=Number(args[0]); end=Number(args[1]); step=1; }
  else if (args.length===3) { start=Number(args[0]); end=Number(args[1]); step=Number(args[2]); }
  else throw runtimeError('range expects 1..3 args');
  const out=[]; if (step===0) throw runtimeError('range step cannot be 0');
  if (step>0) { for (let i=start;i<end;i+=step) out.push(i); }
  else { for (let i=start;i>end;i+=step) out.push(i); }
  return out;
}

function httpGetSync(url) {
  // synchronous GET using node's https + deasync-like behavior via spawn and curl fallback
  try {
    // prefer curl for simplicity if available
    try { return child_process.execSync(`curl -s ${JSON.stringify(url)}`, { encoding: 'utf8' }); } catch(e) { /*fallthrough*/ }
    // fallback to basic https request (async) — but here we can't easily make it sync; return placeholder
    throw new Error('httpGet requires curl in PATH for synchronous fetch');
  } catch (e) { throw runtimeError('httpGet failed: ' + e.message); }
}

// -------------------- Runner & REPL --------------------
function run(source, interp, filename='<input>') {
  const tokens = lex(source, filename);
  const ast = new Parser(tokens).parseProgram();
  return interp.eval(ast);
}

function runFile(pathArg) {
  const src = fs.readFileSync(pathArg, 'utf8');
  const interp = new Interpreter();
  try { run(src, interp, pathArg); } catch (e) { showError(e); process.exitCode = 1; }
}

function showError(e) {
  if (e.token) {
    console.error('Error:', e.message);
    console.error(`  at ${e.token.file}:${e.token.line}:${e.token.col}`);
  } else if (e.isRuntime) {
    console.error(e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0,5).join('\n'));
  } else {
    console.error(e.stack || String(e));
  }
}

function startREPL() {
  const interp = new Interpreter();
  const histFile = path.join(require('os').homedir(), '.aurora_history');
  let history = [];
  try { history = fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean); } catch(e){}
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'aur> ', history });
  console.log('AuroraLang v2 REPL. Type .help for commands. Multi-line buffer executed with `;;` on its own line.');
  rl.prompt();
  let buffer='';
  rl.on('line', (line) => {
    if (line.trim() === '.exit') { rl.close(); return; }
    if (line.trim() === '.help') { console.log('.help .exit .load <file> ;; to execute buffer'); rl.prompt(); return; }
    if (line.trim().startsWith('.load ')) {
      const f = line.trim().slice(6).trim(); try { const src = fs.readFileSync(f,'utf8'); run(src, interp, f); } catch(e){ showError(e); }
      rl.prompt(); return;
    }
    if (line.trim() === ';;') {
      try { const result = run(buffer, interp); if (result!==undefined) console.log(repr(result)); } catch (e) { showError(e); }
      buffer=''; rl.prompt(); return;
    }
    buffer += line + '\n';
    rl.prompt();
  }).on('close', ()=>{ try { fs.writeFileSync(histFile, rl.history.join('\n')); } catch(e){}; console.log('Bye'); process.exit(0); });
}

if (require.main === module) {
  if (process.argv[2]) runFile(process.argv[2]); else startREPL();
}
