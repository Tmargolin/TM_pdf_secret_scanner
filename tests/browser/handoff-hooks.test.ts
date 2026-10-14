// Browser-mode tests (real Chromium): the hooks are installed on a fresh
// same-origin iframe per test, so they never leak into the test runner's page
// or into other tests. Everything a "site" does is done with the iframe's own
// constructors (win.File, win.DataTransfer…), as page code would.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '../../src/main-world/handoff-hooks.ts';

type FrameWindow = Window & typeof globalThis;

let frame: HTMLIFrameElement;
let win: FrameWindow;
let doc: Document;
let forwarded: File[];
let originalInputFiles: () => FileList | null;

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.append(frame);
  win = frame.contentWindow as FrameWindow;
  doc = win.document;
  forwarded = [];
  const getter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'files')?.get;
  if (!getter) throw new Error('no files getter');
  originalInputFiles = getter;
});

afterEach(() => frame.remove());

const install = () => installHooks(win, (file) => void forwarded.push(file));
const pdf = (name: string) => new win.File([`%PDF-1.7 ${name}`], `${name}.pdf`, { type: 'application/pdf' });
const listOf = (...files: File[]) => {
  const transfer = new win.DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
};
const fileInput = (files: File[]) => {
  const input = doc.createElement('input');
  input.type = 'file';
  input.files = listOf(...files).files;
  return input;
};

describe('installation', () => {
  it('wraps every hand-off API (the test page is a secure context, so FileSystemFileHandle exists)', () => {
    expect(install()).toEqual([
      'HTMLInputElement.files',
      'DataTransfer.files',
      'DataTransferItem.getAsFile',
      'DataTransferItem.webkitGetAsEntry',
      'FileSystemFileHandle.getFile',
    ]);
  });

  it('skips a property the page has locked, without throwing', () => {
    const descriptor = Object.getOwnPropertyDescriptor(win.DataTransfer.prototype, 'files');
    Object.defineProperty(win.DataTransfer.prototype, 'files', { ...descriptor, configurable: false });
    const installed = install();
    expect(installed).not.toContain('DataTransfer.files');
    expect(installed).toContain('HTMLInputElement.files');
  });
});

describe('file inputs – every place an input can live', () => {
  it('attached to the page: forwards the file and returns exactly the original value', () => {
    const file = pdf('attached');
    const input = fileInput([file]);
    doc.body.append(input);
    install();
    forwarded.length = 0;
    const value = input.files;
    expect(forwarded).toEqual([file]);
    expect(value).toBe(originalInputFiles.call(input));
    expect(value?.[0]).toBe(file);
  });

  it('detached (never added to the page)', () => {
    const file = pdf('detached');
    install();
    const input = fileInput([file]);
    forwarded.length = 0;
    void input.files;
    expect(forwarded).toEqual([file]);
  });

  it.each(['open', 'closed'] as const)('inside a %s shadow root', (mode) => {
    const file = pdf(`shadow-${mode}`);
    const host = doc.createElement('div');
    doc.body.append(host);
    const root = host.attachShadow({ mode });
    install();
    const input = fileInput([file]);
    root.append(input);
    forwarded.length = 0;
    void input.files;
    expect(forwarded).toEqual([file]);
  });

  it('several files: all forwarded, in order', () => {
    const files = [pdf('one'), pdf('two'), pdf('three')];
    install();
    const input = fileInput(files);
    forwarded.length = 0;
    void input.files;
    expect(forwarded).toEqual(files);
  });

  it('a non-file input: null returned, nothing forwarded', () => {
    install();
    const input = doc.createElement('input');
    expect(input.files).toBeNull();
    expect(forwarded).toEqual([]);
  });

  it('assigning input.files (the setter) still works', () => {
    install();
    const file = pdf('set');
    const input = doc.createElement('input');
    input.type = 'file';
    input.files = listOf(file).files;
    expect(originalInputFiles.call(input)?.[0]).toBe(file);
  });
});

describe('DataTransfer – drag & drop and paste', () => {
  it('drop: the site gets its files, and they are forwarded', () => {
    const file = pdf('dropped');
    const transfer = listOf(file);
    install();
    forwarded.length = 0;
    let siteGot: FileList | undefined;
    doc.addEventListener('drop', (event) => {
      siteGot = event.dataTransfer?.files;
    });
    doc.dispatchEvent(new win.DragEvent('drop', { dataTransfer: transfer }));
    expect(siteGot?.[0]).toBe(file);
    expect(forwarded).toEqual([file]);
  });

  it('paste: clipboardData.files is forwarded', () => {
    const file = pdf('pasted');
    const transfer = listOf(file);
    install();
    forwarded.length = 0;
    doc.addEventListener('paste', (event) => void event.clipboardData?.files);
    doc.dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: transfer }));
    expect(forwarded).toEqual([file]);
  });
});

describe('never breaks the page', () => {
  it('a forward that throws: the page still gets its files and sees no error', () => {
    installHooks(win, () => {
      throw new Error('extension bug');
    });
    const file = pdf('safe');
    const input = fileInput([file]);
    expect(() => input.files).not.toThrow();
    expect(input.files?.[0]).toBe(file);
  });

  it('only the hooked window is affected', () => {
    install();
    const outside = document.createElement('input');
    outside.type = 'file';
    void outside.files; // the test runner's own window: not hooked
    expect(forwarded).toEqual([]);
  });
});
