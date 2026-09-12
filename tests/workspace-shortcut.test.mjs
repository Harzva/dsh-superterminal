import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceShortcut} from '../src/client/workspace-shortcut.mjs';

const selection = {key:'ArrowLeft',altKey:true,shiftKey:true};
test('word selection in an editor or auxiliary panel cannot navigate a terminal', () => {
  for (const scope of ['editor','blocked']) {
    assert.equal(workspaceShortcut(selection,scope),null);
    assert.equal(workspaceShortcut({...selection,key:'Enter'},scope),null);
  }
});
test('IME composition and an already handled event never invoke workspace actions', () => {
  for (const extra of [{isComposing:true},{keyCode:229},{defaultPrevented:true}]) {
    assert.equal(workspaceShortcut({...selection,...extra},'terminal'),null);
  }
});
test('native terminal shortcuts keep directional navigation and zoom', () => {
  for (const [key,action] of [['ArrowLeft','left'],['ArrowRight','right'],['ArrowUp','up'],['ArrowDown','down'],['Enter','zoom']]) {
    assert.equal(workspaceShortcut({...selection,key},'terminal'),action);
  }
});
test('other modifiers and ordinary CLI keys are not consumed', () => {
  for (const extra of [{altKey:false},{shiftKey:false},{metaKey:true},{ctrlKey:true},{key:'a'}]) {
    assert.equal(workspaceShortcut({...selection,...extra},'terminal'),null);
  }
});
