const dbMemo = new WeakMap();
const globalMemo = new Map();

export async function ensureDbSchemaOnce(db, key, runner) {
  if (db && (typeof db === "object" || typeof db === "function")) {
    let map = dbMemo.get(db);
    if (!map) {
      map = new Map();
      dbMemo.set(db, map);
    }

    let promise = map.get(key);
    if (!promise) {
      promise = Promise.resolve()
        .then(runner)
        .catch((error) => {
          map.delete(key);
          throw error;
        });
      map.set(key, promise);
    }
    return promise;
  }

  let promise = globalMemo.get(key);
  if (!promise) {
    promise = Promise.resolve()
      .then(runner)
      .catch((error) => {
        globalMemo.delete(key);
        throw error;
      });
    globalMemo.set(key, promise);
  }
  return promise;
}
