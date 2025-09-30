import { AsyncTracker } from './AsyncTracker.js';
import { ComputedField } from './ComputedField.js';

export class DataLookup {
  static async lookup(obj, path) {
    if (typeof path === 'string') {
      path = path.split('.');
    }

    if (typeof obj === 'function') {
      obj = await obj();
    }

    if (!Array.isArray(path)) {
      return obj;
    }

    while (path.length > 0) {
      const segment = path.shift();

      if (
        obj &&
        typeof obj === 'object' &&
        Object.prototype.hasOwnProperty.call(obj, segment)
      ) {
        obj = obj[segment];

        if (typeof obj === 'function') {
          obj = await obj();
        }
      } else {
        return undefined;
      }
    }

    return obj;
  }

  static async get(obj, path, equalsFunc) {
    if (!AsyncTracker.currentComputation()) {
      return this.lookup(obj, path);
    }

    const result = new ComputedField(async () => {
      return this.lookup(obj, path);
    }, equalsFunc);

    return result();
  }
}
