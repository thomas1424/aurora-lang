"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateJS = generateJS;
function generateJS(ast) {
    if (ast.kind === 'Program') {
        return ast.body.map(b => generateJS(b)).join('\n');
    }
    if (ast.kind === 'NumberLiteral')
        return ast.value;
    if (ast.kind === 'StringLiteral')
        return JSON.stringify(ast.value);
    if (ast.kind === 'Identifier')
        return ast.name;
    if (ast.kind === 'Binary') {
        return `(${generateJS(ast.left)} ${ast.op} ${generateJS(ast.right)})`;
    }
    if (ast.kind === 'VarDecl') {
        return `let ${ast.name} = ${ast.init ? generateJS(ast.init) : 'null'};`;
    }
    if (ast.kind === 'ExprStmt')
        return `${generateJS(ast.expr)};`;
    if (ast.kind === 'Call') {
        const callee = ast.callee.kind === 'Identifier' ? ast.callee.name : '(' + generateJS(ast.callee) + ')';
        const args = ast.args.map(a => generateJS(a)).join(', ');
        // map print builtin to console.log
        if (callee === 'print')
            return `console.log(${args});`;
        return `${callee}(${args})`;
    }
    if (ast.kind === 'Function') {
        const name = ast.name ? ast.name : '';
        return `function ${name}(${ast.params.join(',')}) {\n${ast.body.map(b => generateJS(b)).join('\n')}\n}`;
    }
    if (ast.kind === 'Return')
        return `return ${ast.arg ? generateJS(ast.arg) : ''};`;
    if (ast.kind === 'If') {
        return `if (${generateJS(ast.cond)}) {\n${ast.thenBranch.map(b => generateJS(b)).join('\n')}\n}` + (ast.elseBranch ? ` else {\n${ast.elseBranch.map(b => generateJS(b)).join('\n')}\n}` : '');
    }
    if (ast.kind === 'While') {
        return `while (${generateJS(ast.cond)}) { ${ast.body.map(b => generateJS(b)).join('\n')} }`;
    }
    throw new Error('Unknown AST node in codegen: ' + ast.kind);
}
