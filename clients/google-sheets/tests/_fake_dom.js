function matchesSimpleSelector(element, selector) {
  if (selector.charAt(0) === '.') {
    const className = selector.slice(1);
    return (element.className || '').split(/\s+/).indexOf(className) !== -1;
  }
  const attrMatch = selector.match(/^([a-zA-Z0-9]*)\[([a-zA-Z-]+)=("?)([^"\]]*)\3\]$/);
  if (attrMatch) {
    const tag = attrMatch[1];
    const attr = attrMatch[2];
    const value = attrMatch[4];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    return element.getAttribute(attr) === value;
  }
  return element.tagName === selector.toUpperCase();
}

function queryAll(root, selector) {
  let results = [];
  (root.children || []).forEach(function(child) {
    if (matchesSimpleSelector(child, selector)) results.push(child);
    results = results.concat(queryAll(child, selector));
  });
  return results;
}

function makeFakeDom() {
  const byId = {};
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
    getElementById(id) {
      return byId[id] || null;
    },
  };
  function makeElement(tagName, ownerDocument) {
    let id = '';
    const upperTag = tagName.toUpperCase();
    const element = {
      tagName: upperTag,
      ownerDocument,
      style: {},
      className: '',
      classList: {
        add(name) {
          element.className = [element.className, name].filter(Boolean).join(' ');
        },
      },
      children: [],
      textContent: '',
      dataset: {},
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
      setAttribute(name, value) {
        element._attributes = element._attributes || {};
        element._attributes[name] = String(value);
      },
      getAttribute(name) {
        if (element._attributes && Object.prototype.hasOwnProperty.call(element._attributes, name)) {
          return element._attributes[name];
        }
        // Mirror real DOM attribute/property reflection (e.g. .type, .name)
        // for the handful of properties production code reads via selectors.
        if (name in element && typeof element[name] !== 'function') return element[name];
        return null;
      },
      querySelector(selector) {
        const results = queryAll(element, selector);
        return results.length ? results[0] : null;
      },
      querySelectorAll(selector) {
        return queryAll(element, selector);
      },
    };
    Object.defineProperty(element, 'options', {
      get() {
        return element.children.filter(function(child) {
          return child.tagName === 'OPTION';
        });
      },
    });
    if (upperTag === 'SELECT') {
      // Mirror real <select> semantics: .value and .selectedIndex stay in
      // sync with each other and with the current <option> children, so
      // production code that sets one and reads the other (as a real
      // browser select would) behaves the same way here.
      let selectedIndex = 0;
      Object.defineProperty(element, 'selectedIndex', {
        get() {
          return selectedIndex;
        },
        set(index) {
          selectedIndex = index;
        },
      });
      Object.defineProperty(element, 'value', {
        get() {
          const opt = element.options[selectedIndex];
          return opt ? opt.value : '';
        },
        set(newValue) {
          selectedIndex = element.options.findIndex(function(opt) {
            return opt.value === newValue;
          });
        },
      });
    } else {
      element.value = '';
      element.selectedIndex = 0;
    }
    Object.defineProperty(element, 'innerHTML', {
      get() {
        return '';
      },
      set(_value) {
        element.children = [];
      },
    });
    Object.defineProperty(element, 'id', {
      get() {
        return id;
      },
      set(value) {
        if (id) delete byId[id];
        id = value;
        if (value) byId[value] = element;
      },
    });
    return element;
  }
  return { document, makeElement };
}

module.exports = { makeFakeDom };
