/* @flow */

import fs from 'fs';
import path from 'path';
import { REPLServer } from 'repl';
import v8 from 'v8';
import zlib from 'zlib';
import JSZip from 'jszip';
import ArrayStream from './array-stream';
import * as util from './util';

const sourcePaths = new Set([process.cwd()]);

type SourceType = {|
  source: string,
  modified: number,
|};

type ResourceType =
  | {|
      type: 'bundled',
      src: string,
    |}
  | {|
      type: 'file',
      src: string,
    |}
  | {|
      type: 'jar',
      jarPath: string,
      src: string,
      date: number,
    |};

function isBundled(filename: string): boolean {
  if (__DEV__) {
    return fs.existsSync(`./target/${filename}`);
  }

  const fname = util.isWindows ? filename.replace(/\//g, '\\') : filename;

  return lumo.internal.embedded.resources[fname] != null;
}

export function load(filename: string): ?string {
  if (__DEV__) {
    try {
      return fs.readFileSync(`${__dirname}/${filename}`, 'utf8');
    } catch (e) {
      return null;
    }
  }

  const fname = util.isWindows ? filename.replace(/\//g, '\\') : filename;
  const gzipped = lumo.internal.embedded.get(fname);
  if (gzipped != null) {
    return zlib.inflateSync(gzipped).toString();
  }

  return null;
}

// eslint-disable-next-line flowtype/no-weak-types
export function getGoogleClosureCompiler(): Function {
  v8.setFlagsFromString('--nouse_strict');

  // eslint-disable-next-line global-require
  const googleClosureCompiler = require('google-closure-compiler-js');

  // TODO: don't set use_strict back if it was never on in the first place
  v8.setFlagsFromString('--use_strict');
  return __DEV__ ? googleClosureCompiler.compile : googleClosureCompiler;
}

// TODO: cache JARs that we know have a given file / path
export function readSource(filename: string): ?SourceType {
  for (const srcPath of sourcePaths.values()) {
    try {
      if (srcPath.endsWith('.jar')) {
        const data = fs.readFileSync(srcPath);
        const zip = new JSZip().load(data);
        const file = zip.file(filename);

        if (file != null) {
          return {
            source: file.asText(),
            modified: file.date.getTime(),
          };
        }
      }
      const filePath = path.join(srcPath, filename);
      return {
        source: fs.readFileSync(filePath, 'utf8'),
        modified: fs.statSync(filePath).mtimeMs,
      };
    } catch (_) {} // eslint-disable-line no-empty
  }
  return null;
}

export function readFile(filename: string): ?SourceType {
  try {
    return {
      source: fs.readFileSync(filename, 'utf8'),
      modified: fs.statSync(filename).mtimeMs,
    };
  } catch (_) {} // eslint-disable-line no-empty

  return null;
}

export function readCache(filename: string): ?SourceType {
  try {
    return {
      source: fs.readFileSync(filename, 'utf8'),
      modified: fs.statSync(filename).mtimeMs,
    };
  } catch (_) {
    return null;
  }
}

export function writeCache(filename: string, source: string): ?Error {
  try {
    return fs.writeFileSync(filename, source, 'utf8');
  } catch (e) {
    return e;
  }
}

export function loadUpstreamJsLibs(): string[] {
  const ret = [];
  for (const srcPath of sourcePaths.values()) {
    try {
      if (srcPath.endsWith('.jar')) {
        const data = fs.readFileSync(srcPath);
        const zip = new JSZip().load(data);
        const source = zip.file('deps.cljs');

        if (source != null) {
          ret.push(source.asText());
        }
      } else {
        const source = fs.readFileSync(path.join(srcPath, 'deps.cljs'), 'utf8');
        ret.push(source);
      }
    } catch (_) {} // eslint-disable-line no-empty
  }
  return ret;
}

export function loadUpstreamDataReaders(): { url: string, source: string }[] {
  const ret = [];
  for (const srcPath of sourcePaths.values()) {
    for (const filename of ['data_readers.cljs', 'data_readers.cljc']) {
      const url = path.join(srcPath, filename);

      try {
        if (srcPath.endsWith('.jar')) {
          const data = fs.readFileSync(srcPath);
          const zip = new JSZip().load(data);
          const source = zip.file(filename);

          if (source != null) {
            ret.push({
              url,
              source: source.asText(),
            });
          }
        } else {
          const source = fs.readFileSync(url, 'utf8');
          ret.push({
            url,
            source,
          });
        }
      } catch (_) {} // eslint-disable-line no-empty
    }
  }
  return ret;
}

export function resource(filename: string): ?ResourceType {
  if (isBundled(filename)) {
    return {
      type: 'bundled',
      src: filename,
    };
  }

  for (const srcPath of sourcePaths.values()) {
    if (srcPath.endsWith('.jar')) {
      const data = fs.readFileSync(srcPath);
      const zip = new JSZip().load(data);
      const entries = zip.filter((pathInJar: string) => pathInJar === filename);

      if (entries.length > 0) {
        const entry = entries[0];
        return {
          type: 'jar',
          jarPath: path.resolve(srcPath),
          src: filename,
          date: entry.date,
        };
      }
    }

    if (fs.existsSync(path.join(srcPath, filename))) {
      return {
        type: 'file',
        src: path.resolve(srcPath, filename),
      };
    }
  }

  return null;
}

export function getSourcePaths(): string[] {
  return [...sourcePaths];
}

export function addSourcePaths(srcPaths: string[]): void {
  const expanded = srcPaths.map((srcPath: string) =>
    path.normalize(util.expandPath(srcPath)),
  );

  expanded.forEach((p: string) => sourcePaths.add(p));
}

export function removeSourcePath(srcPath: string): boolean {
  return sourcePaths.delete(util.expandPath(srcPath));
}

export function readSourceFromJar({
  jarPath,
  src,
}: {
  type: string,
  jarPath: string,
  src: string,
}): string {
  const data = fs.readFileSync(jarPath);
  const zip = new JSZip().load(data);
  const source = zip.file(src);

  return source.asText();
}

export function readDirFromJar(jarPath: string, dir: string): string[] {
  const data = fs.readFileSync(jarPath);
  const zip = new JSZip().load(data);

  return zip.file(new RegExp(`^${dir}`)).map((x: { name: string }) => x.name);
}

export function dumpSDK(outdir: string): void {
  if (!__DEV__) {
    lumo.internal.embedded.keys().forEach((res: string) => {
      const idx = res.lastIndexOf('/');

      if (idx !== -1) {
        util.ensureDir(path.join(outdir, res.slice(0, idx)));
      }

      // $FlowFixMe: need to check result of res, but bundled resources will be
      fs.writeFileSync(path.join(outdir, res), load(res), 'utf8');
    });
  }
}

// based on https://github.com/nodejs/node/blob/712596/lib/repl.js#L710
export function getJSCompletions(
  line: string,
  match: string,
  cb: (string[]) => void,
): void {
  const flat = new ArrayStream();
  // $FlowIssue: stream needs to be the 2nd arg
  const nodeReplServer = new REPLServer('', flat);
  const lineWithoutMatch = line.substring(0, line.length - match.length);

  // $FlowIssue: it's there
  return nodeReplServer.completer(
    match,
    (err: ?Error, [jsCompletions]: [string[], string]) => {
      const completions = jsCompletions.reduce((cs: string[], c: string) => {
        if (c === '') {
          return cs;
        }

        cs.push(`${lineWithoutMatch}${c}`);
        return cs;
      }, []);
      return cb(completions);
    },
  );
}
