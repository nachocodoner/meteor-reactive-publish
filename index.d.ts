import { AsyncTrackerComputation } from 'meteor/nachocodoner:reactive-publish';

declare module 'meteor/nachocodoner:reactive-publish' {
  /**
   * AsyncTrackerDependency class for managing reactive dependencies
   */
  class AsyncTrackerDependency {
    constructor();

    /**
     * Establishes a dependency on the current computation
     * @returns {boolean} True if a dependency was established
     */
    depend(): boolean;

    /**
     * Notifies dependents of changes asynchronously
     */
    changed(): Promise<void>;

    /**
     * Notifies dependents of changes synchronously
     */
    changedSync(): void;

    /**
     * Checks if there are any dependents
     * @returns {boolean} True if there are dependents
     */
    hasDependents(): boolean;
  }

  /**
   * AsyncTrackerComputation class representing a reactive computation
   */
  class AsyncTrackerComputation {
    /**
     * The ID of this computation
     */
    _id: number;

    /**
     * Whether this is the first run of the computation
     */
    firstRun: boolean;

    /**
     * Whether the computation has been stopped
     */
    stopped: boolean;

    /**
     * Whether the computation has been invalidated
     */
    invalidated: boolean;

    /**
     * Register a callback to run before the computation runs
     * @param {Function} fn The callback function
     */
    beforeRun(fn: (computation: AsyncTrackerComputation) => void): void;

    /**
     * Register a callback to run after the computation runs
     * @param {Function} fn The callback function
     */
    afterRun(fn: (computation: AsyncTrackerComputation) => void): void;

    /**
     * Register a callback to run when the computation is invalidated
     * @param {Function} fn The callback function
     */
    onInvalidate(fn: (computation: AsyncTrackerComputation) => void): void;

    /**
     * Register a callback to run when the computation is stopped
     * @param {Function} fn The callback function
     */
    onStop(fn: (computation: AsyncTrackerComputation) => void): void;

    /**
     * Stop the computation
     */
    stop(): void;

    /**
     * Rerun once if invalidated (no-op if running)
     */
    flush(): Promise<void>;

    /**
     * Force an immediate re-run
     */
    run(): Promise<void>;
  }

  /**
   * AsyncTracker class for managing reactive computations
   */
  class AsyncTracker {
    /**
     * Create a reactive computation
     * @param {Function} f The function to run reactively
     * @param {Object} options Options for the computation
     * @returns {AsyncTrackerComputation} The computation
     */
    static autorun(
      f: (computation: AsyncTrackerComputation) => any,
      options?: {
        onError?: (error: Error) => void;
        parent?: AsyncTrackerComputation;
      }
    ): AsyncTrackerComputation;

    /**
     * Get the current computation
     * @returns {AsyncTrackerComputation|null} The current computation or null
     */
    static currentComputation(): AsyncTrackerComputation | null;

    /**
     * Run a function with no current computation
     * @param {Function} f The function to run
     * @returns {Promise<any>} The result of the function
     */
    static nonreactive<T>(f: () => T | Promise<T>): Promise<T>;

    /**
     * The AsyncTrackerDependency class
     */
    static Dependency: typeof AsyncTrackerDependency;
  }

  /**
   * ReactiveVarAsync class for reactive variables with async support
   */
  class ReactiveVarAsync<T> {
    /**
     * Create a reactive variable
     * @param {T} initialValue The initial value
     * @param {Function} equalsFunc Optional equality function
     */
    constructor(initialValue: T, equalsFunc?: (a: T, b: T) => boolean);

    /**
     * Get the current value and establish a dependency
     * @returns {T} The current value
     */
    get(): T;

    /**
     * Set a new value and notify dependents asynchronously
     * @param {T} newValue The new value
     */
    set(newValue: T): Promise<void>;

    /**
     * Set a new value and notify dependents synchronously
     * @param {T} newValue The new value
     */
    setSync(newValue: T): void;

    /**
     * Get a string representation of the variable
     * @returns {string} The string representation
     */
    toString(): string;
  }

  // Export the main classes
  export {
    AsyncTracker,
    AsyncTrackerComputation,
    AsyncTrackerDependency,
    ReactiveVarAsync,
  };
}

declare module 'meteor/meteor' {
  // Extend the Meteor namespace
  namespace Meteor {
    // Extend the Meteor.PublishContext interface to include autorun
    interface PublishContext {
      /**
       * Run a function reactively in the publish context
       * @param {Function} runFunc The function to run reactively
       * @returns {Promise<AsyncTrackerComputation>} The computation handle
       */
      autorun(
        runFunc: (computation: AsyncTrackerComputation) => any
      ): Promise<AsyncTrackerComputation>;
    }

    /**
     * Create a reactive publication
     * @param {string} name The name of the publication
     * @param {Function} publishFunction The publish function
     * @param {Object} options Options for the publication
     */
    function publishReactive(
      name: string,
      publishFunction: (this: PublishContext, ...args: any[]) => any,
      options?: object
    ): any;
  }
}
