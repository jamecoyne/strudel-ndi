import { tags as t } from '@lezer/highlight';
import { createTheme } from './theme-helper.mjs';
export const settings = {
  background: '#e8e8e8',
  foreground: '#222222',
  muted: '#22222280',
  caret: '#222222',
  selection: 'rgba(0, 0, 255, 0.2)',
  selectionMatch: '#00000026',
  lineHighlight: '#d0d0d080',
  lineBackground: '#ffffff40',
  gutterBackground: 'transparent',
  gutterForeground: '#555555',
  light: true,
};
const red = '#d01010';
const green = '#108a20';
const blue = '#1040d0';
export default createTheme({
  theme: 'light',
  settings,
  styles: [
    { tag: t.labelName, color: red },
    { tag: t.keyword, color: red },
    { tag: t.operator, color: red },
    { tag: t.special(t.variableName), color: red },
    { tag: t.typeName, color: blue },
    { tag: t.atom, color: blue },
    { tag: t.number, color: blue },
    { tag: t.definition(t.variableName), color: blue },
    { tag: t.string, color: green },
    { tag: t.special(t.string), color: green },
    { tag: t.comment, color: '#777777' },
    { tag: t.variableName, color: 'inherit' },
    { tag: t.tagName, color: red },
    { tag: t.bracket, color: 'inherit' },
    { tag: t.meta, color: green },
    { tag: t.attributeName, color: blue },
    { tag: t.propertyName, color: blue },
    { tag: t.className, color: blue },
    { tag: t.invalid, color: red },
  ],
});
