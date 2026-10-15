// Low level, string/comment/template-literal aware scanners used by the
// runtime error discovery. Pure functions, no I/O, no project knowledge.


// Index of a function body's opening `{`, skipping an optional TypeScript
// return-type annotation (`): Promise<X> {`, `): { a: string } {`).
export function bodyOpen(fileText: string, from: number): number {
  let cursor = from;
  while (cursor < fileText.length && /\s/.test(fileText[cursor])) cursor++;
  if (fileText[cursor] !== ':') {
    return fileText[cursor] === '{' ? cursor : -1;
  }
  cursor++;
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let quote: "'" | '"' | '`' | null = null;
  while (cursor < fileText.length) {
    const c = fileText[cursor];
    if (quote) {
      if (c === '\\') {
        cursor += 2;
        continue;
      }
      if (c === quote) quote = null;
      cursor++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{' && angle === 0 && paren === 0 && bracket === 0) return cursor;
    cursor++;
  }
  return -1;
}

// Index of the '}' closing the '{' at openIdx (string/comment aware).
export function matchBrace(src: string, openIdx: number): number {
  let quote: "'" | '"' | '`' | null = null;
  const tplStack: number[] = [];
  let tplBrace = 0;
  let lineComment = false;
  let blockComment = false;
  let i = openIdx;
  const n = src.length;
  let depthCount = 0;
  while (i < n) {
    const c = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (lineComment) {
      if (c === '\n') lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (c === '*' && nxt === '/') {
        blockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && nxt === '{') {
        tplStack.push(tplBrace);
        tplBrace = 0;
        quote = null;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && nxt === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && nxt === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '{') depthCount++;
    else if (c === '}') {
      if (tplStack.length > 0 && tplBrace === 0) {
        tplBrace = tplStack.pop() as number;
        quote = '`';
      } else {
        depthCount--;
        if (depthCount === 0) return i;
      }
    } else if (c === '(' || c === '[') {
      // tracked only inside statementEnd; ignored here
    }
    i++;
  }
  return -1;
}

// End of a single (braceless) statement: first ';' at paren depth 0.
export function statementEnd(src: string, from: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) return i;
    else if (c === '\n' && depth === 0 && /^\s*(else|catch|finally)\b/.test(src.slice(i))) return i;
    i++;
  }
  return src.length;
}

// Index of the ')' closing the '(' at openIdx. String/comment/template
// aware (templates track ${} brace nesting; regex literals get a cheap
// heuristic skip) so parens inside messages don't end the scan early.
export function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  let brace = 0;
  let quote: "'" | '"' | '`' | null = null;
  const tplStack: number[] = [];
  let lineComment = false;
  let blockComment = false;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (lineComment) {
      if (c === '\n') lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (c === '*' && nxt === '/') {
        blockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && nxt === '{') {
        tplStack.push(brace);
        brace = 0;
        quote = null;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && nxt === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && nxt === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '/' && isRegexStart(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (c === '{') brace++;
    else if (c === '}') {
      if (tplStack.length > 0 && brace === 0) {
        brace = tplStack.pop() as number;
        quote = '`';
      } else {
        brace = Math.max(0, brace - 1);
      }
    }
    i++;
  }
  return -1;
}

// Comma-split that ignores nesting, strings, comments and templates.
export function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote: "'" | '"' | '`' | null = null;
  const tplStack: number[] = [];
  let lineComment = false;
  let blockComment = false;
  let current = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (lineComment) {
      if (c === '\n') lineComment = false;
      current += c;
      i++;
      continue;
    }
    if (blockComment) {
      if (c === '*' && nxt === '/') {
        blockComment = false;
        current += '*/';
        i += 2;
      } else {
        current += c;
        i++;
      }
      continue;
    }
    if (quote) {
      current += c;
      if (c === '\\' && i + 1 < n) {
        current += src[i + 1];
        i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && nxt === '{') {
        tplStack.push(brace);
        brace = 0;
        quote = null;
        current += nxt;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && nxt === '/' && paren === 0 && brace === 0 && bracket === 0) {
      lineComment = true;
      current += c;
      i++;
      continue;
    }
    if (c === '/' && nxt === '*') {
      blockComment = true;
      current += '/*';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      current += c;
      i++;
      continue;
    }
    if (c === '/' && isRegexStart(src, i)) {
      const end = skipRegex(src, i);
      current += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{') brace++;
    else if (c === '}') {
      if (tplStack.length > 0 && brace === 0) {
        brace = tplStack.pop() as number;
        quote = '`';
      } else {
        brace--;
      }
    } else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === ',' && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += c;
    i++;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// Cheap heuristic: a '/' starts a regex literal (not division) when the
// previous significant char can't end an expression.
function isRegexStart(src: string, slashIdx: number): boolean {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if (/[)\]}'\"`0-9A-Za-z_$]/.test(prev)) {
    const word = src.slice(Math.max(0, j - 6), j + 1);
    return /return|typeof|instanceof|in|of|new|void|delete|throw$/.test(word);
  }
  return true;
}

function skipRegex(src: string, slashIdx: number): number {
  let i = slashIdx + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      return i;
    } else if (c === '\n') return i;
    i++;
  }
  return i;
}
