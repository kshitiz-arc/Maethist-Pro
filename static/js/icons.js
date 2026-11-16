/* Renders icons from the vendored registry (static/js/icon-set.js).
 *
 * Three libraries, one family per surface, so two icon styles never sit in
 * the same row:
 *
 *   lucide    the editor (default)             Lucide, ISC
 *   phosphor  Planner, Pomodoro, the tour      Phosphor, MIT
 *   remix     marketing and legal pages        Remix Icon License v1.0
 *
 * A surface opts into a family with data-icon-set="phosphor" on its root;
 * everything else is Lucide. Licences: static/icons/LICENSES.md.
 *
 * Two ways in:
 *   <i class="fas fa-trash"></i>      the legacy names the app's markup and
 *                                     scripts already use, mapped below
 *   <i data-icon="phosphor:coffee"></i>
 *
 * And for scripts that build markup: window.Inkyscib.Icon.svg("lucide:x").
 * Templates do not need either: the icon() Jinja global inlines the same SVG
 * on the server, so those icons are there on first paint.
 *
 * One IIFE, one global namespace (see consent history in TODOS.md for why).
 */
(function () {
    'use strict';

    const REGISTRY = window.InkyscibIconSet || { sets: {}, icons: {} };

    // Legacy fa-* class -> the icon each family uses for that meaning.
    // A family without its own pick falls back to Lucide.
    const LEGACY = {
        'fa-pen': { lucide: 'pen-line', phosphor: 'pencil-line' },
        'fa-eraser': { lucide: 'eraser' },
        'fa-highlighter': { lucide: 'highlighter' },
        'fa-circle': { lucide: 'circle' },
        'fa-square': { lucide: 'square' },
        'fa-compass': { lucide: 'drafting-compass' },
        'fa-play': { lucide: 'play', phosphor: 'play' },
        'fa-pause': { lucide: 'pause', phosphor: 'pause' },
        'fa-forward': { lucide: 'fast-forward', phosphor: 'fast-forward' },
        'fa-ruler-horizontal': { lucide: 'ruler' },
        'fa-undo': { lucide: 'undo-2' },
        'fa-redo': { lucide: 'redo-2' },
        'fa-redo-alt': { lucide: 'redo-2' },
        'fa-rotate-left': { lucide: 'rotate-ccw', phosphor: 'arrow-counter-clockwise' },
        'fa-trash': { lucide: 'trash', phosphor: 'trash' },
        'fa-trash-can': { lucide: 'trash', phosphor: 'trash' },
        'fa-clock': { lucide: 'timer', phosphor: 'timer' },
        'fa-adjust': { lucide: 'contrast' },
        'fa-search-plus': { lucide: 'zoom-in' },
        'fa-search-minus': { lucide: 'zoom-out' },
        'fa-search': { lucide: 'search' },
        'fa-arrows-alt': { lucide: 'move' },
        'fa-expand': { lucide: 'expand' },
        'fa-camera': { lucide: 'camera' },
        'fa-image': { lucide: 'image' },
        'fa-mug-hot': { lucide: 'coffee', phosphor: 'coffee' },
        'fa-coffee': { lucide: 'coffee', phosphor: 'coffee' },
        'fa-couch': { lucide: 'sofa', phosphor: 'couch' },
        'fa-fire': { lucide: 'flame', phosphor: 'fire' },
        'fa-brain': { lucide: 'brain', phosphor: 'brain' },
        'fa-bullseye': { lucide: 'target', phosphor: 'target' },
        'fa-cloud-rain': { lucide: 'cloud-rain', phosphor: 'cloud-rain' },
        'fa-water': { lucide: 'waves-horizontal', phosphor: 'waves' },
        'fa-volume-up': { lucide: 'volume-2', phosphor: 'speaker-high' },
        'fa-volume-mute': { lucide: 'volume-x', phosphor: 'speaker-x' },
        'fa-broom': { lucide: 'brush-cleaning' },
        'fa-cog': { lucide: 'settings', phosphor: 'gear' },
        'fa-times': { lucide: 'x', phosphor: 'x' },
        'fa-check': { lucide: 'check', phosphor: 'check' },
        'fa-check-circle': { lucide: 'circle-check', phosphor: 'check-circle' },
        'fa-exclamation-circle': { lucide: 'circle-alert' },
        'fa-exclamation-triangle': { lucide: 'triangle-alert' },
        'fa-plus': { lucide: 'plus', phosphor: 'plus' },
        'fa-minus': { lucide: 'minus', phosphor: 'minus' },
        'fa-chevron-down': { lucide: 'chevron-down', phosphor: 'caret-down' },
        'fa-arrow-up': { lucide: 'arrow-up' },
        'fa-arrow-down': { lucide: 'arrow-down' },
        'fa-arrow-left': { lucide: 'arrow-left', phosphor: 'arrow-left' },
        'fa-spinner': { lucide: 'loader-circle' },
        'fa-file-pdf': { lucide: 'file-text' },
        'fa-file-powerpoint': { lucide: 'presentation' },
        'fa-book-open': { lucide: 'book-open' },
        'fa-download': { lucide: 'download' },
        'fa-upload': { lucide: 'upload' },
        'fa-github': { remix: 'github-line', lucide: 'file' }
    };
    const LEGACY_NAMES = Object.keys(LEGACY);

    function familyFor(el) {
        const host = el && el.closest ? el.closest('[data-icon-set]') : null;
        const family = host && host.dataset.iconSet;
        return REGISTRY.sets[family] ? family : 'lucide';
    }

    function escapeAttr(value) {
        return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // Same markup as the icon() Jinja global in app.py, so a server-rendered
    // icon and a script-rendered one are indistinguishable.
    function svg(ref, options) {
        const opts = options || {};
        const [family, name] = String(ref).split(':');
        const inner = REGISTRY.icons[ref];
        const spec = REGISTRY.sets[family];
        if (!inner || !spec) {
            warnOnce(ref, `[icons] "${ref}" is not in static/js/icon-set.js. Add it to tools/vendor_icons.py.`);
            return '';
        }
        const paint = spec.mode === 'stroke'
            ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
            : 'fill="currentColor"';
        const cls = ['icon', `icon-${family}`, `icon-${name}`].concat(opts.className ? [opts.className] : []).join(' ');
        const size = opts.size ? ` width="${Number(opts.size)}" height="${Number(opts.size)}"` : '';
        return `<svg class="${escapeAttr(cls)}" viewBox="${spec.viewBox}"${size} ${paint} aria-hidden="true" focusable="false">${inner}</svg>`;
    }

    const warned = new Set();
    function warnOnce(key, message) {
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(message);
    }

    function refFor(el) {
        if (el.dataset.icon) return el.dataset.icon;
        const legacy = LEGACY_NAMES.find((name) => el.classList.contains(name));
        if (!legacy) {
            const unknown = Array.from(el.classList).find((name) => name.startsWith('fa-') && name !== 'fa-spin');
            if (unknown) {
                warnOnce(unknown, `[icons] "${unknown}" has no mapping in static/js/icons.js, so it renders blank.`);
            }
            return null;
        }
        const picks = LEGACY[legacy];
        const family = familyFor(el);
        if (picks[family]) return `${family}:${picks[family]}`;
        const fallback = picks.lucide ? 'lucide' : Object.keys(picks)[0];
        return `${fallback}:${picks[fallback]}`;
    }

    function renderIcon(el) {
        if (!(el instanceof HTMLElement)) return;
        const ref = refFor(el);
        if (!ref) return;

        const first = el.firstElementChild;
        if (el.dataset.renderedIcon === ref && first && first.tagName.toLowerCase() === 'svg') {
            // Some controls switch classes at runtime; keep the styling hook
            // without writing when nothing changed (the observer below would
            // otherwise see its own write).
            if (!el.classList.contains('local-fa')) el.classList.add('local-fa');
            return;
        }
        el.innerHTML = svg(ref);
        el.dataset.renderedIcon = ref;
        el.classList.add('local-fa');
        el.setAttribute('aria-hidden', 'true');
    }

    function renderTree(root) {
        if (!(root instanceof Element)) return;
        if (root.matches('i')) renderIcon(root);
        root.querySelectorAll('i').forEach(renderIcon);
    }

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.Icon = { svg, render: renderTree, has: (ref) => !!REGISTRY.icons[ref] };

    function start() {
        renderTree(document.documentElement);
        new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) renderTree(node);
                    });
                } else if (mutation.target instanceof HTMLElement && mutation.target.tagName === 'I') {
                    renderIcon(mutation.target);
                }
            });
        }).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'data-icon']
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
