const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

function makeFakeDom() {
  const document = {
    listeners: {},
    createElement(tagName) {
      return makeElement(tagName, document);
    },
    createEvent() {
      return {
        initEvent(type) {
          this.type = type;
        },
      };
    },
    addEventListener(type, handler) {
      document.listeners[type] = handler;
    },
  };
  function makeElement(tagName, ownerDocument) {
    const element = {
      tagName: tagName.toUpperCase(),
      ownerDocument,
      style: {},
      className: '',
      classList: {
        add(name) {
          element.className = [element.className, name].filter(Boolean).join(' ');
        },
      },
      children: [],
      value: '',
      textContent: '',
      dataset: {},
      selectedIndex: 0,
      parentNode: null,
      listeners: {},
      appendChild(child) {
        if (child.parentNode && child.parentNode.children) {
          const idx = child.parentNode.children.indexOf(child);
          if (idx !== -1) child.parentNode.children.splice(idx, 1);
        }
        child.parentNode = element;
        element.children.push(child);
        return child;
      },
      insertBefore(child, reference) {
        if (child.parentNode && child.parentNode.children) {
          const idx = child.parentNode.children.indexOf(child);
          if (idx !== -1) child.parentNode.children.splice(idx, 1);
        }
        child.parentNode = element;
        const index = element.children.indexOf(reference);
        if (index === -1) {
          element.children.push(child);
        } else {
          element.children.splice(index, 0, child);
        }
        return child;
      },
      addEventListener(type, handler) {
        element.listeners[type] = handler;
      },
      dispatchEvent(event) {
        if (event.type === 'change') {
          element.selectedIndex = Math.max(0, element.options.findIndex(function(option) {
            return option.value === element.value;
          }));
        }
        if (element.listeners[event.type]) {
          element.listeners[event.type](event);
        }
      },
      focus() {
        if (element.listeners.focus) {
          element.listeners.focus({ target: element });
        }
      },
    };
    Object.defineProperty(element, 'options', {
      get() {
        return element.children.filter(function(child) {
          return child.tagName === 'OPTION';
        });
      },
    });
    Object.defineProperty(element, 'innerHTML', {
      get() {
        return '';
      },
      set(_value) {
        element.children = [];
      },
    });
    return element;
  }
  return { document, makeElement };
}

test('attachSearchDropdown_ shows all options and panel on open', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - FoodWineHousehold - Coop', '[X] Family - Coffee'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/' + index;
    option.textContent = label;
    select.appendChild(option);
  });

  sandbox.attachSearchDropdown_(select, function(query, options) {
    return options.filter(function(option) {
      return sandbox.isOrderedCharacterMatch_(query, option.label);
    });
  });

  // Structure: parent > wrapper(host) > [valueDisplay, panel > [input, select]]
  const wrapper = parent.children[0];
  const valueDisplay = wrapper.children[0];
  const panel = wrapper.children[1];

  // Simulate click on the value display to open the dropdown
  valueDisplay.listeners.mousedown({ preventDefault() {} });

  assert.equal(panel.style.display, 'block');
  assert.equal(select.options.length, 3);
});

test('attachSearchDropdown_ debounces filtering and updates native select options', async () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['[X] Family - FoodWineHousehold - Coop', '[X] Family - Coffee'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = 'accounts/' + index;
    option.textContent = label;
    select.appendChild(option);
  });

  sandbox.attachSearchDropdown_(select, function(query, options) {
    return options.filter(function(option) {
      return sandbox.isOrderedCharacterMatch_(query, option.label);
    });
  });

  const panel = parent.children[0].children[1];
  const input = panel.children[0];

  // Open the dropdown first
  parent.children[0].children[0].listeners.mousedown({ preventDefault() {} });

  // Type a query — before debounce fires, still 2 options
  input.value = 'ffoc';
  input.listeners.input({ target: input });
  assert.equal(select.options.length, 2);

  // After debounce fires, filtered to 1
  await new Promise(function(resolve) { setTimeout(resolve, 220); });
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, 'accounts/0');
});

test('attachSearchDropdown_ syncs selected option into value display and closes panel', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - Food'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/food';
    option.textContent = label;
    select.appendChild(option);
  });

  const controller = sandbox.attachSearchDropdown_(select, function(_query, options) {
    return options;
  });

  const wrapper = parent.children[0];
  const valueDisplay = wrapper.children[0];
  const valueText = valueDisplay.children[0];
  const panel = wrapper.children[1];

  controller.open();
  select.value = 'accounts/food';
  select.selectedIndex = 1;
  select.dispatchEvent({ type: 'change' });

  assert.equal(select.value, 'accounts/food');
  assert.equal(valueText.textContent, '[X] Family - Food');
  assert.equal(panel.style.display, 'none');
});

test('attachSearchDropdown_ clear() resets value to blank, shows placeholder, and hides panel', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - Food'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/food';
    option.textContent = label;
    select.appendChild(option);
  });

  const controller = sandbox.attachSearchDropdown_(select, function(_query, options) {
    return options;
  });

  const wrapper = parent.children[0];
  const valueDisplay = wrapper.children[0];
  const valueText = valueDisplay.children[0];
  const panel = wrapper.children[1];

  controller.open();
  select.value = 'accounts/food';
  select.selectedIndex = 1;
  select.dispatchEvent({ type: 'change' });
  assert.equal(valueText.textContent, '[X] Family - Food');

  controller.clear();

  assert.equal(select.value, '');
  assert.equal(panel.style.display, 'none');
  assert.ok(valueText.className.includes('placeholder'), 'expected placeholder class after clear');
});

test('attachSearchDropdown_ closes panel when clicking outside the wrapper', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - Food'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/food';
    option.textContent = label;
    select.appendChild(option);
  });

  const controller = sandbox.attachSearchDropdown_(select, function(_query, options) {
    return options;
  });

  const wrapper = parent.children[0];
  const panel = wrapper.children[1];

  controller.open();
  assert.equal(panel.style.display, 'block');

  const outside = makeElement('div', document);
  document.listeners.mousedown({ target: outside });

  assert.equal(panel.style.display, 'none');
});

test('attachSearchDropdown_ valueText has placeholder class initially and loses it after a non-empty selection', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - Food'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/food';
    option.textContent = label;
    select.appendChild(option);
  });

  sandbox.attachSearchDropdown_(select, function(_query, options) {
    return options;
  });

  const wrapper = parent.children[0];
  const valueDisplay = wrapper.children[0];
  const valueText = valueDisplay.children[0];
  const panel = wrapper.children[1];

  assert.ok(valueText.className.includes('placeholder'), 'expected placeholder class on init');

  valueDisplay.listeners.mousedown({ preventDefault() {} });
  select.value = 'accounts/food';
  select.selectedIndex = 1;
  select.dispatchEvent({ type: 'change' });

  assert.ok(!valueText.className.includes('placeholder'), 'expected no placeholder class after selection');
  assert.equal(panel.style.display, 'none');
});

test('attachSearchDropdown_ closing the panel clears the search input', () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  ['None', '[X] Family - Food'].forEach(function(label, index) {
    const option = makeElement('option', document);
    option.value = index === 0 ? '' : 'accounts/food';
    option.textContent = label;
    select.appendChild(option);
  });

  const controller = sandbox.attachSearchDropdown_(select, function(_query, options) {
    return options;
  });

  const wrapper = parent.children[0];
  const panel = wrapper.children[1];
  const input = panel.children[0];

  controller.open();
  input.value = 'foo';

  select.value = 'accounts/food';
  select.selectedIndex = 1;
  select.dispatchEvent({ type: 'change' });

  assert.equal(input.value, '');
});

test('attachSearchDropdown_ preserves data-* attributes on options through list rebuilds', async () => {
  const { document, makeElement } = makeFakeDom();
  const { sandbox } = loadCode({ setTimeout, clearTimeout });
  const parent = makeElement('div', document);
  const select = makeElement('select', document);
  parent.appendChild(select);
  [
    { value: '', label: '— All', dataset: {} },
    { value: '[A] Bank', label: '[A] Bank', dataset: { variant: 'prefix' } },
    { value: '[A] Bank - Checking', label: '[A] Bank - Checking', dataset: {} },
  ].forEach(function(spec) {
    const option = makeElement('option', document);
    option.value = spec.value;
    option.textContent = spec.label;
    option.dataset = spec.dataset;
    select.appendChild(option);
  });

  sandbox.attachSearchDropdown_(select, function(_query, options) { return options; });

  const panel = parent.children[0].children[1];
  const input = panel.children[0];

  parent.children[0].children[0].listeners.mousedown({ preventDefault() {} });
  input.value = 'bank';
  input.listeners.input({ target: input });
  await new Promise(function(resolve) { setTimeout(resolve, 220); });

  const rebuildPrefix = select.options.find(function(o) { return o.value === '[A] Bank'; });
  const rebuildLeaf = select.options.find(function(o) { return o.value === '[A] Bank - Checking'; });
  assert.equal(rebuildPrefix && rebuildPrefix.dataset.variant, 'prefix', 'prefix option keeps data-variant');
  assert.ok(!rebuildLeaf || !rebuildLeaf.dataset.variant, 'leaf option has no data-variant');
});
