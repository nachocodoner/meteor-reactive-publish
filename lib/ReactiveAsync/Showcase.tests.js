import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';

// Showcases

// Example 1: Simple reactive counter
Tinytest.addAsync('Showcase - Reactive counter', async function (test) {
  // Create a reactive counter
  const counter = new ReactiveVarAsync(0);

  // Track values and updates
  let currentValue = null;
  let updateCount = 0;

  // Create a computation that displays the counter value
  const computation = AsyncTracker.autorun(async () => {
    updateCount++;
    currentValue = counter.get();
    console.log(`Counter value: ${currentValue}`);
  });

  // Wait for initial run
  await Meteor._sleepForMs(50);

  // Verify initial state
  test.equal(updateCount, 1, 'Computation should run once initially');
  test.equal(currentValue, 0, 'Counter should start at 0');

  // Increment the counter
  await counter.set(1);
  await Meteor._sleepForMs(50);

  // Verify the update
  test.equal(updateCount, 2, 'Computation should run after counter change');
  test.equal(currentValue, 1, 'Counter should be updated to 1');

  // Increment again
  await counter.set(2);
  await Meteor._sleepForMs(50);

  // Verify the update
  test.equal(
    updateCount,
    3,
    'Computation should run after second counter change'
  );
  test.equal(currentValue, 2, 'Counter should be updated to 2');

  // Clean up
  computation.stop();
});

// Example 2: Simple async data fetching
Tinytest.addAsync('Showcase - Async data fetching', async function (test) {
  // Create reactive variables for our data state
  const data = new ReactiveVarAsync(null);
  const isLoading = new ReactiveVarAsync(false);

  // Simulate fetching data from an API
  async function fetchData() {
    await isLoading.set(true);

    // Simulate network delay
    await Meteor._sleepForMs(50);

    // Return some mock data
    const result = { name: 'John', age: 30 };

    await data.set(result);
    await isLoading.set(false);

    return result;
  }

  // Track component state
  let componentRenders = 0;
  let currentData = null;
  let loadingState = null;

  // Create a component that displays data and loading state
  const component = AsyncTracker.autorun(async () => {
    componentRenders++;

    // Get current values
    loadingState = isLoading.get();
    currentData = data.get();

    // In a real app, this would update the UI
    if (loadingState) {
      console.log('Loading data...');
    } else if (currentData) {
      console.log(`Data loaded: ${JSON.stringify(currentData)}`);
    } else {
      console.log('No data available');
    }
  });

  // Wait for initial run
  await Meteor._sleepForMs(50);

  // Verify initial state
  test.equal(componentRenders, 1, 'Component should render once initially');
  test.isNull(currentData, 'Data should be null initially');
  test.isFalse(loadingState, 'Should not be loading initially');

  // Fetch data
  await fetchData();

  // Wait for updates to propagate
  await Meteor._sleepForMs(50);

  // Verify final state
  test.equal(
    componentRenders,
    4,
    'Component should render after loading starts and completes'
  );
  test.isNotNull(currentData, 'Data should be loaded');
  test.equal(currentData.name, 'John', 'Should have the correct data');
  test.isFalse(loadingState, 'Should not be loading after data is fetched');

  // Clean up
  component.stop();
});

// Example 3: Todo list with reactive state
Tinytest.addAsync('Showcase - Todo list', async function (test) {
  // Create reactive state for our todo list
  const todos = new ReactiveVarAsync([]);
  const newTodoText = new ReactiveVarAsync('');
  const filter = new ReactiveVarAsync('all'); // 'all', 'active', or 'completed'

  // Track component state
  let renderCount = 0;
  let visibleTodos = [];

  // Create a component that displays filtered todos
  const todoList = AsyncTracker.autorun(async () => {
    renderCount++;

    const allTodos = todos.get();
    const currentFilter = filter.get();

    // Apply filter
    if (currentFilter === 'active') {
      visibleTodos = allTodos.filter((todo) => !todo.completed);
    } else if (currentFilter === 'completed') {
      visibleTodos = allTodos.filter((todo) => todo.completed);
    } else {
      visibleTodos = allTodos;
    }

    // In a real app, this would update the UI
    console.log(`Showing ${currentFilter} todos: ${visibleTodos.length} items`);
  });

  // Helper functions for todo operations
  async function addTodo(text) {
    const currentTodos = todos.get();
    await todos.set([
      ...currentTodos,
      { id: Date.now(), text, completed: false },
    ]);
  }

  async function toggleTodo(id) {
    const currentTodos = todos.get();
    await todos.set(
      currentTodos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  }

  async function changeFilter(newFilter) {
    await filter.set(newFilter);
  }

  // Wait for initial run
  await Meteor._sleepForMs(50);

  // Verify initial state
  test.equal(renderCount, 1, 'Component should render once initially');
  test.equal(visibleTodos.length, 0, 'Should have no todos initially');

  // Add some todos
  await addTodo('Learn Meteor');
  await Meteor._sleepForMs(50);

  await addTodo('Master AsyncTracker');
  await Meteor._sleepForMs(50);

  await addTodo('Build an app');
  await Meteor._sleepForMs(50);

  // Verify todos were added
  test.equal(
    renderCount,
    4,
    'Component should render after each todo is added'
  );
  test.equal(visibleTodos.length, 3, 'Should have 3 todos');

  // Mark a todo as completed
  await toggleTodo(visibleTodos[0].id);
  await Meteor._sleepForMs(50);

  // Filter to show only active todos
  await changeFilter('active');
  await Meteor._sleepForMs(50);

  // Verify filter works
  test.equal(
    renderCount,
    6,
    'Component should render after toggle and filter change'
  );
  test.equal(visibleTodos.length, 2, 'Should have 2 active todos');

  // Filter to show only completed todos
  await changeFilter('completed');
  await Meteor._sleepForMs(50);

  // Verify filter works
  test.equal(renderCount, 7, 'Component should render after filter change');
  test.equal(visibleTodos.length, 1, 'Should have 1 completed todo');

  // Clean up
  todoList.stop();
});

// Example 4: Using await with ReactiveVarAsync before and after
Tinytest.addAsync(
  'Showcase - Await with ReactiveVarAsync',
  async function (test) {
    // Create reactive variables for our example
    const userPreferences = new ReactiveVarAsync({
      theme: 'light',
      fontSize: 'medium',
    });
    const userData = new ReactiveVarAsync({
      name: 'User',
      lastLogin: new Date(),
    });
    const notifications = new ReactiveVarAsync([]);

    // Track computation runs and values
    let computationRuns = 0;
    let beforeAwaitPrefs = null;
    let beforeAwaitData = null;
    let afterAwaitPrefs = null;
    let afterAwaitNotifications = null;

    // Create a computation that accesses reactive variables before and after await
    const computation = AsyncTracker.autorun(async () => {
      computationRuns++;

      // Get values BEFORE the await
      beforeAwaitPrefs = userPreferences.get();
      beforeAwaitData = userData.get();
      console.log(
        `[Before await] User ${beforeAwaitData.name} prefers ${beforeAwaitPrefs.theme} theme`
      );

      // Simulate an async operation (like fetching data from a server)
      await Meteor._sleepForMs(20);

      // Get values AFTER the await - these will reflect any changes that happened
      // during the await, demonstrating that reactivity works across await boundaries
      afterAwaitPrefs = userPreferences.get();
      afterAwaitNotifications = notifications.get();

      console.log(
        `[After await] User ${userData.get().name} has ${afterAwaitNotifications.length} notifications`
      );
      console.log(`[After await] Theme is now: ${afterAwaitPrefs.theme}`);
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Verify initial state
    test.equal(computationRuns, 1, 'Computation should run once initially');
    test.equal(
      beforeAwaitPrefs.theme,
      'light',
      'Should get initial theme preference'
    );
    test.equal(beforeAwaitData.name, 'User', 'Should get initial user data');
    test.equal(
      afterAwaitPrefs.theme,
      'light',
      'After await should have same theme initially'
    );
    test.equal(
      afterAwaitNotifications.length,
      0,
      'Should have no notifications initially'
    );

    // Change a preference while the computation is not running
    await userPreferences.set({ ...userPreferences.get(), theme: 'dark' });

    // Wait for the computation to rerun
    await Meteor._sleepForMs(50);

    // Verify the update
    test.equal(
      computationRuns,
      2,
      'Computation should rerun after preference change'
    );
    test.equal(
      beforeAwaitPrefs.theme,
      'dark',
      'Before await should see updated theme'
    );
    test.equal(
      afterAwaitPrefs.theme,
      'dark',
      'After await should see updated theme'
    );

    // Now let's simulate a change that happens DURING the await
    // First, set up a timeout to change values while the computation is awaiting
    let timeoutTriggered = false;

    // Create a helper function to change values during the await
    const changeValuesDuringAwait = () => {
      timeoutTriggered = true;
      // Add a notification while the computation is in the middle of running
      const currentNotifications = notifications.get();
      notifications.setSync([
        ...currentNotifications,
        { id: 1, message: 'New message!' },
      ]);
    };

    // Set the timeout to trigger during the next computation run
    setTimeout(changeValuesDuringAwait, 10);

    // Trigger a rerun by changing user data
    await userData.set({ ...userData.get(), lastLogin: new Date() });

    // Wait for the computation to complete
    await Meteor._sleepForMs(100);

    // Verify that changes during await were detected
    test.equal(
      computationRuns,
      3,
      'Computation should rerun after user data change'
    );
    test.isTrue(timeoutTriggered, 'Timeout should have triggered during await');
    test.equal(
      afterAwaitNotifications.length,
      1,
      'After await should see the new notification'
    );
    test.equal(
      afterAwaitNotifications[0].message,
      'New message!',
      'Should have the correct notification message'
    );

    // Clean up
    computation.stop();
  }
);
