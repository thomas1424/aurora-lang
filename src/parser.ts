// src/parser.ts
import { Token } from './lexer';

export type AST =
  | { kind: 'Program', body: AST[] }
  | { kind: 'NumberLiteral', value: string }
  | { kind: 'StringLiteral', value: string }
  | { kind: 'Identifier', name: string }
  | { kind: 'Binary', op: string, left: AST, right: AST }
  | { kind: 'VarDecl', name: string, init?: AST }
  | { kind: 'ExprStmt', expr: AST }
  | { kind: 'Call', callee: AST, args: AST[] }
  | { kind: 'Function', name?: string, params: string[], body: AST[] }
  | { kind: 'Return', arg?: AST }
  | { kind: 'If', cond: AST, thenBranch: AST[], elseBranch?: AST[] }
  | { kind: 'While', cond: AST, body: AST[] };

export class Parser {
  tokens: Token[]; i = 0;
  constructor(tokens: Token[]) { this.tokens = tokens; }

  peek() { return this.tokens[this.i]; }
  eat(type?: string) {
    const t = this.tokens[this.i++];
    if (type && t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    return t;
  }
  match(...types: string[]) { if (types.includes(this.peek().type)) { return this.eat(); } return null; }

  parseProgram(): AST {
    const body: AST[] = [];
    while (this.peek().type !== 'EOF') body.push(this.parseStatement());
    return { kind: 'Program', body };
  }

  parseStatement(): AST {
    const t = this.peek();
    if (t.type === 'LET') {
      this.eat('LET'); const name = this.eat('IDENT').text;
      this.eat('=');
      const init = this.parseExpression();
      if (this.peek().type === ';') this.eat(';');
      return { kind: 'VarDecl', name, init };
    }
    if (t.type === 'FUN') {
      this.eat('FUN');
      let name: string|undefined = undefined;
      if (this.peek().type === 'IDENT') name = this.eat('IDENT').text;
      this.eat('(');
      const params: string[] = [];
      while (this.peek().type !== ')') {
        params.push(this.eat('IDENT').text);
        if (this.peek().type === ',') this.eat(',');
      }
      this.eat(')');
      const body = this.parseBlock();
      return { kind: 'Function', name, params, body };
    }
    if (t.type === 'RETURN') {
      this.eat('RETURN'); const arg = this.parseExpression(); if (this.peek().type === ';') this.eat(';'); return { kind: 'Return', arg };
    }
    if (t.type === '{') {
      const body = this.parseBlock(); return { kind:'Program', body };
    }
    // fallback: expression statement
    const expr = this.parseExpression();
    if (this.peek().type === ';') this.eat(';');
    return { kind: 'ExprStmt', expr };
  }

  parseBlock(): AST[] {
    this.eat('{'); const body: AST[] = [];
    while (this.peek().type !== '}') {
      body.push(this.parseStatement());
    }
    this.eat('}');
    return body;
  }

  parseExpression(): AST {
    return this.parseBinary();
  }

  parseBinary(precedence = 0): AST {
    let left = this.parsePrimary();
    while (true) {
      const opToken = this.peek();
      const prec = binaryPrecedence(opToken.type);
      if (prec === 0 || prec <= precedence) break;
      const op = this.eat().type;
      const right = this.parseBinary(prec);
      left = { kind: 'Binary', op, left, right };
    }
    return left;
  }

  parsePrimary(): AST {
    const t = this.peek();
    if (t.type === 'NUMBER') { this.eat('NUMBER'); return { kind: 'NumberLiteral', value: t.text }; }
    if (t.type === 'STRING') { this.eat('STRING'); return { kind: 'StringLiteral', value: t.text }; }
    if (t.type === 'IDENT') {
      const id = this.eat('IDENT').text;
      if (this.peek().type === '(') { // call
        this.eat('(');
        const args: AST[] = [];
        while (this.peek().type !== ')') {
          args.push(this.parseExpression());
          if (this.peek().type === ',') this.eat(',');
        }
        this.eat(')');
        return { kind: 'Call', callee: { kind: 'Identifier', name: id }, args };
      }
      return { kind: 'Identifier', name: id };
    }
    if (t.type === '(') {
      this.eat('('); const expr = this.parseExpression(); this.eat(')'); return expr;
    }
    throw new Error('Unexpected token in primary: ' + t.type);
  }
}

function binaryPrecedence(op: string) {
  if (op === '||') return 1;
  if (op === '&&') return 2;
  if (op === '==' || op === '!=') return 3;
  if (op === '<' || op === '>' || op === '<=' || op === '>=') return 4;
  if (op === '+' || op === '-') return 5;
  if (op === '*' || op === '/' || op === '%') return 6;
  return 0;
}
