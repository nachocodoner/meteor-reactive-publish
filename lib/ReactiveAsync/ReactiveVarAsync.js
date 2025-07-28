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
    return `ReactiveVarAsync{${this.get()}}`;
  }

  _numListeners() {
    return this.dep._dependents.size;
  }

  static _isEqual(a, b) {
    if (a !== b) return false;
    return !a || ['number', 'boolean', 'string'].includes(typeof a);
  }
}

export { ReactiveVarAsync };
