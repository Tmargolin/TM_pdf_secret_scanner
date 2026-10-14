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

describe('DataTransferItem.getAsFile', () => {
  it('forwards the file and returns it unchanged', () => {
    const file = pdf('item');
    const transfer = listOf(file);
    install();
    forwarded.length = 0;
    const item = transfer.items[0];
    expect(item?.getAsFile()).toBe(file);
    expect(forwarded).toEqual([file]);
  });

  it('a text item: null returned, nothing forwarded', () => {
    const transfer = new win.DataTransfer();
    transfer.items.add('just text', 'text/plain');
    install();
    expect(transfer.items[0]?.getAsFile()).toBeNull();
    expect(forwarded).toEqual([]);
  });
});

describe('FileSystemFileHandle.getFile (real OPFS file)', () => {
  const opfsFile = async (name: string) => {
    const root = await win.navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(`%PDF-1.7 ${name}`);
    await writable.close();
    return handle;
  };

  it('forwards the file; the page awaits the same promise and gets the file', async () => {
    const handle = await opfsFile('opfs.pdf');
    install();
    const promise = handle.getFile();
    expect(promise).toBeInstanceOf(win.Promise);
    const file = await promise;
    await Promise.resolve();
    expect(file.name).toBe('opfs.pdf');
    expect(forwarded).toEqual([file]);
  });

  it('a failing getFile still rejects for the page', async () => {
    install();
    const broken = Object.create(win.FileSystemFileHandle.prototype) as FileSystemFileHandle;
    // try/catch instead of rejects.toThrow: the error comes from the iframe's realm.
    let rejected = false;
    try {
      await broken.getFile();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(forwarded).toEqual([]);
  });
});

describe('folder drops – the entry chain (D36, stand-ins for Chrome\'s hidden entry types)', () => {
  // Chrome's real entry objects can only come from a real drop of a real
  // folder, so these classes play their part; the hooks find their prototypes
  // the same way (Object.getPrototypeOf) as for the real ones.
  function standIns() {
    const calls: unknown[][] = [];
    class FileEntry {
      constructor(private readonly content: File) {}
      get isFile() {
        return true;
      }
      get isDirectory() {
        return false;
      }
      file(...args: unknown[]) {
        calls.push(args);
        const success = args[0];
        if (typeof success === 'function') setTimeout(() => success(this.content), 0);
      }
    }
    class Reader {
      constructor(private entries: unknown[]) {}
      readEntries(success: (entries: unknown[]) => void) {
        const batch = this.entries;
        this.entries = [];
        setTimeout(() => success(batch), 0);
      }
    }
    class DirEntry {
      constructor(private readonly children: unknown[]) {}
      get isFile() {
        return false;
      }
      get isDirectory() {
        return true;
      }
      createReader() {
        return new Reader(this.children);
      }
      getFile(path: string, _options: unknown, success: (entry: unknown) => void) {
        setTimeout(() => success(new FileEntry(pdf(path.replace('.pdf', '')))), 0);
      }
    }
    return { FileEntry, DirEntry, calls };
  }

  /** What a site does with a dropped folder: walk it recursively, collecting Files. */
  async function walk(entry: { isFile: boolean }, out: File[]): Promise<void> {
    if (entry.isFile) {
      out.push(await new Promise<File>((resolve) => (entry as unknown as { file(cb: (f: File) => void): void }).file(resolve)));
      return;
    }
    const reader = (entry as unknown as { createReader(): { readEntries(cb: (e: unknown[]) => void): void } }).createReader();
    for (;;) {
      const batch = await new Promise<unknown[]>((resolve) => reader.readEntries(resolve));
      if (batch.length === 0) return;
      for (const child of batch) await walk(child as { isFile: boolean }, out);
    }
  }

  /** Makes dataTransfer.items[i].webkitGetAsEntry() return `entry`, as a drop would. */
  function dropped(entry: unknown) {
    Object.defineProperty(win.DataTransferItem.prototype, 'webkitGetAsEntry', {
      value: () => entry,
      configurable: true,
      writable: true,
    });
    return listOf(pdf('placeholder')).items[0] as DataTransferItem;
  }

  it('forwards every file of a nested folder; the site gets the same files', async () => {
    const { FileEntry, DirEntry } = standIns();
    const top = pdf('top');
    const deep = pdf('deep');
    const item = dropped(new DirEntry([new FileEntry(top), new DirEntry([new FileEntry(deep)])]));
    install();
    forwarded.length = 0;
    const siteGot: File[] = [];
    await walk(item.webkitGetAsEntry() as unknown as { isFile: boolean }, siteGot);
    expect(siteGot).toEqual([top, deep]);
    expect(forwarded).toEqual([top, deep]);
  });

  it('directory.getFile(path) → entry.file(): forwarded', async () => {
    const { DirEntry } = standIns();
    const folder = new DirEntry([]);
    const item = dropped(folder);
    install();
    item.webkitGetAsEntry();
    const file = await new Promise<File>((resolve) =>
      folder.getFile('named.pdf', {}, (entry) => (entry as { file(cb: (f: File) => void): void }).file(resolve)),
    );
    expect(file.name).toBe('named.pdf');
    expect(forwarded).toContain(file);
  });

  it('wraps each prototype only once, however many entries pass', async () => {
    const { FileEntry, DirEntry } = standIns();
    const item = dropped(new DirEntry([new FileEntry(pdf('a')), new FileEntry(pdf('b'))]));
    install();
    await walk(item.webkitGetAsEntry() as unknown as { isFile: boolean }, []);
    const wrapped = FileEntry.prototype.file;
    await walk(item.webkitGetAsEntry() as unknown as { isFile: boolean }, []);
    expect(FileEntry.prototype.file).toBe(wrapped);
  });

  it('passes the page\'s other arguments through and leaves a missing callback alone', () => {
    const { FileEntry, calls } = standIns();
    const entry = new FileEntry(pdf('x'));
    dropped(entry);
    install();
    listOf(pdf('p')).items[0]?.webkitGetAsEntry();
    const onError = () => {};
    entry.file(undefined, onError);
    expect(calls[0]).toEqual([undefined, onError]);
  });

  it('a throwing forward does not break the folder walk', async () => {
    const { FileEntry, DirEntry } = standIns();
    const file = pdf('safe');
    const item = dropped(new DirEntry([new FileEntry(file)]));
    installHooks(win, () => {
      throw new Error('extension bug');
    });
    const siteGot: File[] = [];
    await walk(item.webkitGetAsEntry() as unknown as { isFile: boolean }, siteGot);
    expect(siteGot).toEqual([file]);
  });

  it('webkitGetAsEntry returning null (a text item): null returned', () => {
    const item = dropped(null);
    install();
    expect(item.webkitGetAsEntry()).toBeNull();
  });
});

describe('defensive paths – odd pages and odd objects never break anything', () => {
  /** Locks a property the way a page could, so it cannot be wrapped. */
  const lock = (proto: object, name: string) => {
    Object.defineProperty(proto, name, { ...Object.getOwnPropertyDescriptor(proto, name), configurable: false });
  };

  it('every API locked by the page: nothing installed, no error', () => {
    lock(win.HTMLInputElement.prototype, 'files');
    lock(win.DataTransfer.prototype, 'files');
    lock(win.DataTransferItem.prototype, 'getAsFile');
    lock(win.DataTransferItem.prototype, 'webkitGetAsEntry');
    lock(win.FileSystemFileHandle.prototype, 'getFile');
    expect(install()).toEqual([]);
  });

  it('an insecure page without FileSystemFileHandle: the other four are installed', () => {
    const { HTMLInputElement, DataTransfer, DataTransferItem, FileList, File } = win;
    expect(installHooks({ HTMLInputElement, DataTransfer, DataTransferItem, FileList, File }, () => {})).toEqual([
      'HTMLInputElement.files',
      'DataTransfer.files',
      'DataTransferItem.getAsFile',
      'DataTransferItem.webkitGetAsEntry',
    ]);
  });

  it('getFile returning something that is not a promise: returned unchanged', () => {
    Object.defineProperty(win.FileSystemFileHandle.prototype, 'getFile', {
      value: () => 'not a promise',
      configurable: true,
      writable: true,
    });
    install();
    const handle = Object.create(win.FileSystemFileHandle.prototype) as { getFile(): unknown };
    expect(handle.getFile()).toBe('not a promise');
  });

  /** webkitGetAsEntry returns `entry`; returns what the page gets back. */
  const pass = (entry: unknown) => {
    Object.defineProperty(win.DataTransferItem.prototype, 'webkitGetAsEntry', {
      value: () => entry,
      configurable: true,
      writable: true,
    });
    install();
    return listOf(pdf('p')).items[0]?.webkitGetAsEntry();
  };

  it('an entry that is neither file nor folder: returned unchanged, its prototype untouched', () => {
    class Odd {
      file() {
        return 'original';
      }
    }
    const before = Odd.prototype.file;
    const odd = new Odd();
    expect(pass(odd)).toBe(odd);
    expect(Odd.prototype.file).toBe(before);
  });

  it('an entry without a prototype: returned unchanged', () => {
    const bare = Object.create(null) as object;
    expect(pass(bare)).toBe(bare);
  });

  it('a folder whose reader is null, or has no prototype: returned unchanged', () => {
    for (const reader of [null, Object.create(null) as object]) {
      class Dir {
        get isFile() {
          return false;
        }
        get isDirectory() {
          return true;
        }
        createReader() {
          return reader;
        }
      }
      const dir = pass(new Dir()) as unknown as Dir;
      expect(dir.createReader()).toBe(reader);
    }
  });

  it('readEntries calling back with something that is not a list: handed on unchanged', async () => {
    class Reader {
      readEntries(success: (value: unknown) => void) {
        setTimeout(() => success('not a list'), 0);
      }
    }
    class Dir {
      get isFile() {
        return false;
      }
      get isDirectory() {
        return true;
      }
      createReader() {
        return new Reader();
      }
    }
    const dir = pass(new Dir()) as unknown as Dir;
    const value = await new Promise((resolve) => dir.createReader().readEntries(resolve));
    expect(value).toBe('not a list');
  });
});
