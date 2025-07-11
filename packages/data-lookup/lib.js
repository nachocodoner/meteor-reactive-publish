import { Tracker } from 'meteor/tracker';
import { ComputedField } from 'meteor/computed-field'; // Assumes this exists and is imported correctly

export class DataLookup {
  static lookup(obj, path) {
    if (typeof path === 'string') {
      path = path.split('.');
    }

    if (typeof obj === 'function') {
      obj = obj();
    }

    if (!Array.isArray(path)) {
      return obj;
    }

    while (path.length > 0) {
      const segment = path.shift();

      if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, segment)) {
        obj = obj[segment];

        if (typeof obj === 'function') {
          obj = obj();
        }
      } else {
        return undefined;
      }
    }

    return obj;
  }

  static get(obj, path, equalsFunc) {
    if (!Tracker.active) {
      return this.lookup(obj, path);
    }

    const result = new ComputedField(() => {
      return this.lookup(obj, path);
    }, equalsFunc);

    return result();
  }
}
