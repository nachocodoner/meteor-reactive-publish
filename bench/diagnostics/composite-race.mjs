import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
// Run against upstream's unmodified lib directory; no Meteor app is needed.
// Only the scheduler and Meteor environment/check helpers are simulated.
const dir = process.argv[2];
if (!dir) throw new Error('Pass the publish-composite 1.9.0 lib directory');
const sourceHashes = {};

const deps = {
  Meteor: { bindEnvironment: (fn) => fn },
  Match: { Optional: (x) => x, OneOf: () => {} },
  check: () => {},
  debugLog: () => {},
  valueOfId: (id) => id,
};
function load(file, name) {
  const original = fs.readFileSync(path.join(dir, file), 'utf8');
  sourceHashes[file] = createHash('sha256').update(original).digest('hex');
  const source = original
    .replace(/^import .*$/gm, '')
    .replace(/^export default .*$/m, '');
  return Function(
    ...Object.keys(deps),
    source + '\nreturn ' + name
  )(...Object.values(deps));
}
deps.PublishedDocument = load('published_document.js', 'PublishedDocument');
deps.PublishedDocumentList = load(
  'published_document_list.js',
  'PublishedDocumentList'
);
const Publication = load('publication.js', 'Publication');
const published = new Set();
const handles = [];
const gates = [];
const subscription = {
  meteorSub: {},
  added: (c, doc) => published.add(doc._id),
  changed: () => {},
  removed: (c, id) => published.delete(id),
};
function cursor(ids, wait = false) {
  return {
    _getCollectionName: () => 'posts',
    observe: async (callbacks) => {
      if (wait) await new Promise((resolve) => gates.push(resolve));
      for (const id of ids) await callbacks.added({ _id: id });
      const handle = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      handles.push(handle);
      return handle;
    },
  };
}
let current = cursor(['old']);
const publication = new Publication(subscription, { find: () => current });
await publication.publish();
await publication.awaitPromises();
current = cursor(['old'], true);
const first = publication._republish();
await new Promise((resolve) => setImmediate(resolve));
current = cursor(['new']);
await publication._republish();
await publication.awaitPromises();
assert.deepEqual([...published], ['new']);
gates[0]();
await first;
await publication.awaitPromises();
const afterOverlap = [...published];
publication.unpublish();
const leaked = handles.filter((h) => !h.stopped).length;
console.log(
  JSON.stringify(
    {
      upstream: 'reywood:publish-composite@1.9.0',
      sourceHashes,
      expected: ['new'],
      actual: afterOverlap,
      observersAfterStop: leaked,
    },
    null,
    2
  )
);
assert.ok(afterOverlap.includes('old'));
assert.equal(leaked, 1);
