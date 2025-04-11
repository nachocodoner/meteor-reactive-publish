export const extendPublish = (newPublishArguments) => {
  // DDP Server constructor.
  const Server = Object.getPrototypeOf(Meteor.server).constructor;

  // A helper function that mimics underscore's isObject (returns true for objects and functions)
  const isObject = (val) =>
    val !== null && (typeof val === 'object' || typeof val === 'function');

  // Save the original publish function and override it.
  const originalPublish = Server.prototype.publish;
  Server.prototype.publish = function (...args) {
    // If the first argument is an object, let the original publish handle it.
    if (isObject(args[0])) {
      return originalPublish.apply(this, args);
    }

    // Otherwise, transform the arguments and then call the original publish function.
    const newArgs = newPublishArguments.apply(this, args);
    return originalPublish.apply(this, newArgs);
  };

  // Similarly, wrap Meteor.publish.
  const originalMeteorPublish = Meteor.publish;
  Meteor.publish = function (...args) {
    if (isObject(args[0])) {
      return originalMeteorPublish.apply(this, args);
    }
    const newArgs = newPublishArguments.apply(this, args);
    return originalMeteorPublish.apply(this, newArgs);
  };
};
