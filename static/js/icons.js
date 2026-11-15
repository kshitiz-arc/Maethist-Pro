(function () {
    function strokeIcon(shapes, viewBox) {
        return `<svg viewBox="${viewBox || '0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
    }

    function fillIcon(shapes, viewBox) {
        return `<svg viewBox="${viewBox || '0 0 24 24'}" fill="currentColor" aria-hidden="true">${shapes}</svg>`;
    }

    const ICONS = {
        'fa-pen': strokeIcon(`
            <path d="M3 21l4.2-1 11-11a2.2 2.2 0 1 0-3.1-3.1l-11 11L3 21Z"/>
            <path d="M13.8 6.2l4 4"/>
        `),
        'fa-eraser': strokeIcon(`
            <path d="m7 21 10.6-10.6"/>
            <path d="m5.5 12.5 6.8-6.8a2.6 2.6 0 0 1 3.7 0l2.3 2.3a2.6 2.6 0 0 1 0 3.7L12 18H7.6l-2.1-2.1a2.4 2.4 0 0 1 0-3.4Z"/>
            <path d="m14.3 7.4 3.3 3.3"/>
        `),
        'fa-highlighter': strokeIcon(`
            <path d="m14 4 6 6"/>
            <path d="m3 21 7-1 10-10-6-6L4 14l-1 7Z"/>
            <path d="M11 7 17 13"/>
            <path d="M2.5 21.5h7"/>
        `),
        'fa-circle': strokeIcon('<circle cx="12" cy="12" r="8.5"/>'),
        'fa-square': strokeIcon('<rect x="4" y="4" width="16" height="16" rx="2"/>'),
        'fa-compass': strokeIcon(`
            <circle cx="12" cy="5.1" r="1.4" fill="currentColor" stroke="none"/>
            <path d="M10.7 6.4 5.5 19"/>
            <path d="M13.3 6.4 18.5 19"/>
            <path d="M8.2 15.6h2.5"/>
            <path d="M4.6 17.1a8 8 0 0 1 14.8 0" stroke-dasharray="1.6 2.4"/>
        `),
        'fa-play': fillIcon('<polygon points="8,5 19,12 8,19"/>'),
        'fa-ruler-horizontal': strokeIcon(`
            <rect x="3" y="8" width="18" height="8" rx="1.5"/>
            <path d="M7 8v3"/>
            <path d="M10 8v2"/>
            <path d="M13 8v3"/>
            <path d="M16 8v2"/>
        `),
        'fa-undo': strokeIcon(`
            <path d="M9 7H4v5"/>
            <path d="M4 12c2-3 4.8-4.5 8.5-4.5 4.5 0 7.5 3 7.5 7.5 0 1.7-.4 3.1-1.2 4.5"/>
        `),
        'fa-redo': strokeIcon(`
            <path d="M15 7h5v5"/>
            <path d="M20 12c-2-3-4.8-4.5-8.5-4.5-4.5 0-7.5 3-7.5 7.5 0 1.7.4 3.1 1.2 4.5"/>
        `),
        'fa-redo-alt': strokeIcon(`
            <path d="M15 7h5v5"/>
            <path d="M20 12c-2-3-4.8-4.5-8.5-4.5-4.5 0-7.5 3-7.5 7.5 0 1.7.4 3.1 1.2 4.5"/>
        `),
        'fa-trash': strokeIcon(`
            <path d="M4 7h16"/>
            <path d="M9 7V4h6v3"/>
            <path d="M7 7l1 12h8l1-12"/>
            <path d="M10 11v5"/>
            <path d="M14 11v5"/>
        `),
        'fa-trash-can': strokeIcon(`
            <path d="M4 7h16"/>
            <path d="M9 7V4h6v3"/>
            <path d="M7 7l1 12h8l1-12"/>
            <path d="M10 11v5"/>
            <path d="M14 11v5"/>
        `),
        'fa-clock': strokeIcon(`
            <circle cx="12" cy="12" r="8.5"/>
            <path d="M12 7v5l3 2"/>
        `),
        'fa-adjust': `
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.85"/>
                <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/>
            </svg>
        `,
        'fa-search-plus': strokeIcon(`
            <circle cx="10.5" cy="10.5" r="5.5"/>
            <path d="m15 15 5 5"/>
            <path d="M10.5 8v5"/>
            <path d="M8 10.5h5"/>
        `),
        'fa-search-minus': strokeIcon(`
            <circle cx="10.5" cy="10.5" r="5.5"/>
            <path d="m15 15 5 5"/>
            <path d="M8 10.5h5"/>
        `),
        'fa-arrows-alt': strokeIcon(`
            <path d="M12 3v18"/>
            <path d="M3 12h18"/>
            <path d="m12 3 3 3"/>
            <path d="m12 3-3 3"/>
            <path d="m12 21 3-3"/>
            <path d="m12 21-3-3"/>
            <path d="m3 12 3-3"/>
            <path d="m3 12 3 3"/>
            <path d="m21 12-3-3"/>
            <path d="m21 12-3 3"/>
        `),
        'fa-camera': strokeIcon(`
            <path d="M5 8h3l1.5-2h5L16 8h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/>
            <circle cx="12" cy="13" r="3.5"/>
        `),
        'fa-mug-hot': strokeIcon(`
            <path d="M6 10h8a0 0 0 0 1 0 0v4.5A3.5 3.5 0 0 1 10.5 18h-1A3.5 3.5 0 0 1 6 14.5V10a0 0 0 0 1 0 0Z"/>
            <path d="M14 11h1.5a2.5 2.5 0 0 1 0 5H14"/>
            <path d="M8 5c1 1 1 2 0 3"/>
            <path d="M11 4c1 1 1 2 0 3"/>
            <path d="M5 20h11"/>
        `),
        'fa-coffee': strokeIcon(`
            <path d="M6 10h8a0 0 0 0 1 0 0v4.5A3.5 3.5 0 0 1 10.5 18h-1A3.5 3.5 0 0 1 6 14.5V10a0 0 0 0 1 0 0Z"/>
            <path d="M14 11h1.5a2.5 2.5 0 0 1 0 5H14"/>
            <path d="M5 20h11"/>
        `),
        'fa-times': strokeIcon(`
            <path d="M6 6 18 18"/>
            <path d="M18 6 6 18"/>
        `),
        'fa-broom': strokeIcon(`
            <path d="m13 5 6 6"/>
            <path d="m4 20 7-7"/>
            <path d="M9 15 5 19"/>
            <path d="m11 13 6-6 2 2-6 6"/>
            <path d="M3 21h5"/>
        `),
        'fa-pause': fillIcon(`
            <rect x="7" y="5" width="4" height="14" rx="1"/>
            <rect x="13" y="5" width="4" height="14" rx="1"/>
        `),
        // A gear with real teeth. This was a circle with eight loose rays,
        // which is the sun/brightness symbol, and it was reported as "does not
        // even look like a settings icon". Built as one filled silhouette with
        // the axle cut out, so the teeth read as part of a wheel at 16px.
        'fa-cog': fillIcon(`<path fill-rule="evenodd" d="${(() => {
            const teeth = 8, outer = 10.4, inner = 7.7, hole = 3.1;
            const at = (angle, radius) =>
                `${(12 + Math.cos(angle) * radius).toFixed(2)} ${(12 + Math.sin(angle) * radius).toFixed(2)}`;
            let d = '';
            for (let k = 0; k < teeth; k += 1) {
                const mid = (k / teeth) * Math.PI * 2 - Math.PI / 2;
                const next = ((k + 1) / teeth) * Math.PI * 2 - Math.PI / 2;
                d += `${k === 0 ? 'M' : 'L'}${at(mid - 0.27, inner)}` +
                    `L${at(mid - 0.17, outer)}L${at(mid + 0.17, outer)}L${at(mid + 0.27, inner)}` +
                    `A${inner} ${inner} 0 0 1 ${at(next - 0.27, inner)}`;
            }
            return `${d}Z M${12 + hole} 12A${hole} ${hole} 0 1 0 ${12 - hole} 12A${hole} ${hole} 0 1 0 ${12 + hole} 12Z`;
        })()}"/>`),
        // Reset is a counter-clockwise loop back to the start. fa-redo-alt
        // was used for it and reads as "redo".
        'fa-rotate-left': strokeIcon(`
            <path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.25"/>
            <path d="M4.2 3.9v3.7h3.7"/>
        `),
        'fa-cloud-rain': strokeIcon(`
            <path d="M7.2 15.2a4.2 4.2 0 1 1 .7-8.35A5.3 5.3 0 0 1 18 8.4a3.4 3.4 0 0 1-.6 6.8Z"/>
            <path d="m8.4 18.2-.9 2.2"/>
            <path d="m12.4 18.2-.9 2.2"/>
            <path d="m16.4 18.2-.9 2.2"/>
        `),
        'fa-water': strokeIcon(`
            <path d="M2.5 8.5c1.6-1.4 3.1-1.4 4.7 0s3.1 1.4 4.8 0 3.1-1.4 4.7 0 3.1 1.4 4.8 0"/>
            <path d="M2.5 13.5c1.6-1.4 3.1-1.4 4.7 0s3.1 1.4 4.8 0 3.1-1.4 4.7 0 3.1 1.4 4.8 0"/>
            <path d="M2.5 18.5c1.6-1.4 3.1-1.4 4.7 0s3.1 1.4 4.8 0 3.1-1.4 4.7 0 3.1 1.4 4.8 0"/>
        `),
        'fa-chevron-down': strokeIcon('<path d="m6 9 6 6 6-6"/>'),
        'fa-brain': strokeIcon(`
            <path d="M9 7a3 3 0 0 0-5 2 3 3 0 0 0 1.1 5A3.5 3.5 0 0 0 8.5 18H10"/>
            <path d="M15 7a3 3 0 0 1 5 2 3 3 0 0 1-1.1 5A3.5 3.5 0 0 1 15.5 18H14"/>
            <path d="M10 6a2.5 2.5 0 0 1 4 0"/>
            <path d="M10 18a2.5 2.5 0 0 0 4 0"/>
            <path d="M10 8.5v7"/>
            <path d="M14 8.5v7"/>
            <path d="M12 7v10"/>
        `),
        'fa-github': strokeIcon(`
            <path d="M9 18c-4 1.3-4-2-6-2"/>
            <path d="M15 21v-3.5c0-1 .1-1.7-.4-2.3 1.7-.2 3.9-.8 3.9-4.2 0-1-.4-1.9-1-2.5.1-.3.4-1.4-.1-2.8 0 0-.9-.3-3 1.1a10 10 0 0 0-5.5 0c-2.1-1.4-3-1.1-3-1.1-.5 1.4-.2 2.5-.1 2.8-.6.6-1 1.5-1 2.5 0 3.4 2.2 4 3.9 4.2-.5.6-.8 1.3-.8 2.3V21"/>
        `),
        'fa-arrow-up': strokeIcon(`
            <path d="M12 20V4"/>
            <path d="m6 10 6-6 6 6"/>
        `),
        'fa-arrow-down': strokeIcon(`
            <path d="M12 4v16"/>
            <path d="m6 14 6 6 6-6"/>
        `),
        'fa-arrow-left': strokeIcon(`
            <path d="M20 12H4"/>
            <path d="m10 6-6 6 6 6"/>
        `),
        'fa-minus': strokeIcon('<path d="M5 12h14"/>'),
        'fa-plus': strokeIcon(`
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
        `),
        'fa-check': strokeIcon('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
        'fa-check-circle': strokeIcon(`
            <circle cx="12" cy="12" r="8.5"/>
            <path d="m7.8 12.3 2.7 2.7 5.8-6"/>
        `),
        'fa-exclamation-circle': strokeIcon(`
            <circle cx="12" cy="12" r="8.5"/>
            <path d="M12 7.5v5.8"/>
            <path d="M12 16.5v.01"/>
        `),
        'fa-search': strokeIcon(`
            <circle cx="10.5" cy="10.5" r="5.5"/>
            <path d="m15 15 5 5"/>
        `),
        'fa-expand': strokeIcon(`
            <path d="M4 9V4h5"/>
            <path d="M15 4h5v5"/>
            <path d="M20 15v5h-5"/>
            <path d="M9 20H4v-5"/>
        `),
        'fa-exclamation-triangle': strokeIcon(`
            <path d="M12 3.5 2.6 19.5h18.8L12 3.5Z"/>
            <path d="M12 9.5V14"/>
            <path d="M12 16.8v.01"/>
        `),
        'fa-spinner': strokeIcon('<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/>'),
        'fa-file-pdf': strokeIcon(`
            <path d="M6 3h8l4 4v14H6z"/>
            <path d="M14 3v4h4"/>
            <path d="M9 12h6"/>
            <path d="M9 15.5h6"/>
        `),
        'fa-file-powerpoint': strokeIcon(`
            <path d="M6 3h8l4 4v14H6z"/>
            <path d="M14 3v4h4"/>
            <path d="M10 17v-6h2.3a2 2 0 0 1 0 4H10"/>
        `),
        'fa-forward': fillIcon(`
            <polygon points="4,6 11.5,12 4,18"/>
            <polygon points="12,6 19.5,12 12,18"/>
        `),
        'fa-fire': strokeIcon(`
            <path d="M12 21c-3.6 0-6.2-2.4-6.2-5.8 0-2.5 1.5-4.3 2.8-5.9.9-1.1 1.9-2.3 2.3-3.8.1-.5.2-1 .2-1.5 2.6 1.4 4.3 3.7 4.4 6.4.6-.6 1-1.4 1.2-2.2 1 1.3 1.5 3 1.5 4.6 0 4.6-2.6 8.2-6.2 8.2Z"/>
            <path d="M12 21c-1.7 0-2.9-1.2-2.9-2.9 0-1.5 1-2.4 1.9-3.5.4-.5.9-1 1.2-1.7 1.6 1 2.7 2.7 2.7 4.5 0 2-1.2 3.6-2.9 3.6Z"/>
        `),
        'fa-volume-up': strokeIcon(`
            <path d="M4 9.5h3L11.5 6v12L7 14.5H4z"/>
            <path d="M15 9.5a4 4 0 0 1 0 5"/>
            <path d="M17.5 7a7.5 7.5 0 0 1 0 10"/>
        `),
        'fa-volume-mute': strokeIcon(`
            <path d="M4 9.5h3L11.5 6v12L7 14.5H4z"/>
            <path d="m15 9.5 5 5"/>
            <path d="m20 9.5-5 5"/>
        `),
        'fa-couch': strokeIcon(`
            <path d="M5 10V8.5A2.5 2.5 0 0 1 7.5 6h9A2.5 2.5 0 0 1 19 8.5V10"/>
            <path d="M5 10a2 2 0 0 0-2 2v4h18v-4a2 2 0 0 0-2-2"/>
            <path d="M5 10v3h14v-3"/>
            <path d="M4 16v2"/>
            <path d="M20 16v2"/>
        `),
        'fa-bullseye': strokeIcon(`
            <circle cx="12" cy="12" r="8.5"/>
            <circle cx="12" cy="12" r="4.5"/>
            <path d="M12 12v.01"/>
        `),
        'fa-book-open': strokeIcon(`
            <path d="M12 6.5C10.4 5.1 8.3 4.5 3 4.5v13c5.3 0 7.4.6 9 2 1.6-1.4 3.7-2 9-2v-13c-5.3 0-7.4.6-9 2Z"/>
            <path d="M12 6.5v13"/>
        `),
        'fa-download': strokeIcon(`
            <path d="M12 4v10"/>
            <path d="m7.5 10.5 4.5 4.5 4.5-4.5"/>
            <path d="M4.5 19.5h15"/>
        `),
        'fa-upload': strokeIcon(`
            <path d="M12 15V5"/>
            <path d="M7.5 9 12 4.5 16.5 9"/>
            <path d="M4.5 19.5h15"/>
        `)
    };

    const ICON_CLASS_NAMES = Object.keys(ICONS);

    function findIconClass(el) {
        return ICON_CLASS_NAMES.find((iconName) => el.classList.contains(iconName)) || null;
    }

    // This is a local-only icon set: no Font Awesome webfont is loaded, so an
    // unregistered fa-* class renders nothing at all and the control ships
    // blank. Silent is the worst outcome, so say so once per unknown name.
    const warnedIcons = new Set();
    function warnUnknownIcon(el) {
        const unknown = Array.from(el.classList).find(
            (name) => name.startsWith('fa-') && !ICON_CLASS_NAMES.includes(name)
        );
        if (!unknown || warnedIcons.has(unknown)) return;
        warnedIcons.add(unknown);
        console.warn(
            `[icons] "${unknown}" is not in the local icon set, so it renders blank. ` +
            'Add it to ICONS in icons.js, or use an inline <svg class="tool-icon"> instead.'
        );
    }

    function renderIcon(el) {
        if (!(el instanceof HTMLElement)) return;

        const iconClass = findIconClass(el);
        if (!iconClass) {
            warnUnknownIcon(el);
            return;
        }

        const firstChild = el.firstElementChild;
        const isRendered = el.dataset.localFaIcon === iconClass &&
            firstChild &&
            firstChild.tagName.toLowerCase() === 'svg';

        if (isRendered) {
            // Some controls switch icon classes at runtime. Re-applying
            // className used to remove local-fa and leave an unstyled SVG.
            // Guard each write because this function also runs from the
            // class MutationObserver; unconditional writes can self-trigger.
            if (!el.classList.contains('local-fa')) el.classList.add('local-fa');
            if (el.getAttribute('aria-hidden') !== 'true') el.setAttribute('aria-hidden', 'true');
            return;
        }

        el.innerHTML = ICONS[iconClass];
        el.dataset.localFaIcon = iconClass;
        el.classList.add('local-fa');
        el.setAttribute('aria-hidden', 'true');
    }

    function renderTree(root) {
        if (!(root instanceof Element)) return;

        if (root.matches('i')) {
            renderIcon(root);
        }

        root.querySelectorAll('i').forEach(renderIcon);
    }

    function start() {
        renderTree(document.documentElement);

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            renderTree(node);
                        }
                    });
                    return;
                }

                if (
                    mutation.type === 'attributes' &&
                    mutation.target instanceof HTMLElement &&
                    mutation.target.tagName.toLowerCase() === 'i'
                ) {
                    renderIcon(mutation.target);
                }
            });
        });

        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class']
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
