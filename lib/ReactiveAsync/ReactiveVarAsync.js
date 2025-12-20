import { AsyncTracker } from './AsyncTracker';

class ReactiveVarAsync {
  constructor(initialValue, equalsFunc) {
    this.curValue = initialValue;
    this.equalsFunc = equalsFunc;
    this.dep = new AsyncTracker.Dependency();
  }

  get() {
    this.dep.depend();
    return this.curValue;
  }

  async set(newValue) {
    const equals = this.equalsFunc || ReactiveVarAsync._isEqual;
    if (equals(this.curValue, newValue)) {
      return;
    }
    this.curValue = newValue;
    await this.dep.changed();
  }

  setSync(newValue) {
    const equals = this.equalsFunc || ReactiveVarAsync._isEqual;
    if (equals(this.curValue, newValue)) {
      return;
    }
    this.curValue = newValue;
    this.dep.changedSync();
  }

  toString() {
    // Don't establish a dependency when converting to string
    return `ReactiveVarAsync{${this.curValue}}`;
  }

  _numListeners() {
    // Use hasDependents() to check if there are any dependents
    return this.dep.hasDependents() ? this.dep._dependents.size : 0;
  }

  static _isEqual(a, b) {
    if (a !== b) return false;
    return !a || ['number', 'boolean', 'string'].includes(typeof a);
  }
}

export { ReactiveVarAsync };
