import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentService,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { EditLanguage } from '../../core/edit-language';

// CodeMirror 的配置：行号、撤销、查找替换、括号配对、语法颜色。
// 颜色都用 editor.css 里的变量，跟着深浅色走；界面文字换成中文。

const PHRASES = {
  Find: '查找',
  Replace: '替换为',
  next: '下一个',
  previous: '上一个',
  all: '全部选中',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '整词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '替换了 $ 处',
  'replaced match on line $': '替换了第 $ 行的匹配',
  'on line': '在第几行',
  'Go to line': '跳到第几行',
  go: '跳转',
};

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: 'var(--ed-comment)' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--ed-keyword)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName), t.labelName], color: 'var(--ed-key)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.url, t.character], color: 'var(--ed-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--ed-number)' },
  { tag: [t.variableName, t.special(t.variableName)], color: 'var(--ed-variable)' },
  { tag: [t.typeName, t.className, t.tagName, t.namespace], color: 'var(--ed-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--ed-func)' },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--content)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '1.5px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--ed-selection) !important',
  },
  '.cm-gutters': { backgroundColor: 'var(--content)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 10px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'var(--ed-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--ed-line)', color: 'var(--text)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-match)', outline: '1px solid var(--ed-match-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ed-match-on)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ed-match)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--bar)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line2)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line2)' },
});

/** 一个文件的编辑器配置。language 是已经加载好的语法 */
export function editorExtensions(language: Extension, onSave: () => void): Extension[] {
  return [
    EditorState.phrases.of(PHRASES),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('    '),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(highlight),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    theme,
    language,
  ];
}

const loaded = new Map<EditLanguage, Promise<Extension>>();

/** 语法按需加载，同一种只加载一次 */
export function loadLanguage(lang: EditLanguage): Promise<Extension> {
  let p = loaded.get(lang);
  if (!p) {
    p = importLanguage(lang).catch(() => []);
    loaded.set(lang, p);
  }
  return p;
}

/**
 * 老式语法（nginx、shell 这些）算不准缩进，回车后会顶格。让它们“算不出来”，
 * CodeMirror 就照上一行的缩进来，配置文件里这样最顺手
 */
function legacy(parser: StreamParser<unknown>): Extension {
  return [StreamLanguage.define(parser), Prec.high(indentService.of(() => null))];
}

async function importLanguage(lang: EditLanguage): Promise<Extension> {
  switch (lang) {
    case 'nginx':
      return legacy((await import('@codemirror/legacy-modes/mode/nginx')).nginx);
    case 'shell':
      return legacy((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'toml':
      return legacy((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'ini':
      return legacy((await import('@codemirror/legacy-modes/mode/properties')).properties);
    case 'dockerfile':
      return legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'plain':
      return [];
  }
}
