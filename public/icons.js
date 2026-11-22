/* =====================================================================
   BLOOP icons — сгенерированный набор мини-аватарок вместо эмодзи.
   Единый стиль: скруглённые плитки с градиентом акцентов приложения
   и белым глифом внутри; для реакций — цветные кружки-смайлы.
   Все иконки — inline SVG: резкие на любом DPI, не зависят от шрифтов.
   ===================================================================== */

(function () {
  const G = {
    azure:  ['#7aa2ff', '#4c6fff'],
    violet: ['#a78bff', '#8f6cff'],
    rose:   ['#ff7aa8', '#ff5c8a'],
    amber:  ['#ffb066', '#ff8a5c'],
    mint:   ['#4fe3a5', '#2bb673'],
    cyan:   ['#5ce0e6', '#2dd4bf'],
  };
  let uid = 0;

  // белые глифы (paths для 24×24)
  const P = {
    sprout:  '<path d="M12 18.5v-5.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M12 13C8.8 13 7 11.2 6.4 8.2c3.1-.1 5.3 1.3 5.6 4.8z" fill="#fff"/><path d="M12 11.5c.4-2.8 2.2-4.3 5.4-4.4-.2 2.9-1.9 4.5-5.4 4.4z" fill="#fff" opacity=".85"/>',
    pen:     '<path d="M14.7 5.6l3.7 3.7L9.6 18.1l-4.6 1 1-4.6z" stroke="#fff" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M13.2 7.1l3.7 3.7" stroke="#fff" stroke-width="1.7"/>',
    clapper: '<rect x="4.5" y="10" width="15" height="8" rx="1.6" fill="#fff"/><path d="M5.2 9.2L18.9 6.4l.6 2.8-13.7 2.8z" fill="#fff"/><path d="M7.4 6.7l1.6 2.5M11.4 5.9l1.6 2.5M15.4 5.1l1.5 2.5" stroke="#4c6fff" stroke-width="1.3"/>',
    camera:  '<rect x="3.8" y="7.8" width="11" height="8.4" rx="2" fill="#fff"/><path d="M15.8 11.2l4.4-2.4v6.4l-4.4-2.4z" fill="#fff"/>',
    mic:     '<rect x="9.6" y="4.5" width="4.8" height="9" rx="2.4" fill="#fff"/><path d="M7 11.5a5 5 0 0 0 10 0M12 16.8v2.7" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
    heart:   '<path d="M12 19.3s-6.7-4.3-6.7-9.2A3.9 3.9 0 0 1 12 7.4a3.9 3.9 0 0 1 6.7 2.7c0 4.9-6.7 9.2-6.7 9.2z" fill="#fff"/>',
    flame:   '<path d="M12 4.4c1 2.7 4.6 4.5 4.6 8.2a4.6 4.6 0 0 1-9.2 0c0-1.7.7-3 1.6-4.2.3 1.1.9 1.9 1.7 2.3-.4-2.2.2-4.4 1.3-6.3z" fill="#fff"/>',
    chat:    '<path d="M5.5 5.5h13A2 2 0 0 1 20.5 7.5v7a2 2 0 0 1-2 2h-7.6L7 19.8v-3.3h-1.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" fill="#fff"/>',
    sparkle: '<path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6-5.6-1.9 5.6-1.9z" fill="#fff"/>',
    envelope:'<rect x="4" y="6" width="16" height="12" rx="2" stroke="#fff" stroke-width="1.7" fill="none"/><path d="M4.8 7.2L12 13l7.2-5.8" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
    trophy:  '<path d="M8 5h8v5.5a4 4 0 0 1-8 0z" fill="#fff"/><path d="M8 6.2H5.5v1.6A3.2 3.2 0 0 0 8.5 11M16 6.2h2.5v1.6A3.2 3.2 0 0 1 15.5 11" stroke="#fff" stroke-width="1.5" fill="none"/><path d="M10.5 17.5h3M9 20h6M12 14.8v2.7" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
    robot:   '<rect x="6" y="8" width="12" height="9" rx="2.5" stroke="#fff" stroke-width="1.7" fill="none"/><circle cx="9.6" cy="12" r="1.3" fill="#fff"/><circle cx="14.4" cy="12" r="1.3" fill="#fff"/><path d="M12 8V5.4M12 4.2v0" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="4" r="1.2" fill="#fff"/><path d="M4.5 12v2M19.5 12v2" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
    palette: '<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.3 0 1.9-.8 1.9-1.7 0-.8-.5-1.3-.5-2 0-1 .8-1.7 2-1.7h1.6a3.7 3.7 0 0 0 3.2-3.8C20 6.7 16.4 3.8 12 3.8z" fill="#fff"/><circle cx="8.3" cy="9.2" r="1.2" fill="#4c6fff"/><circle cx="12" cy="7.6" r="1.2" fill="#4c6fff"/><circle cx="15.6" cy="9.2" r="1.2" fill="#4c6fff"/><circle cx="7.6" cy="13.2" r="1.2" fill="#4c6fff"/>',
    chart:   '<rect x="5" y="12" width="3.4" height="7" rx="1" fill="#fff"/><rect x="10.3" y="8" width="3.4" height="11" rx="1" fill="#fff"/><rect x="15.6" y="4.5" width="3.4" height="14.5" rx="1" fill="#fff"/>',
    trend:   '<path d="M4 16.5l4.8-4.8 3.4 3.4L18.5 9" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.8 8.6h4.2v4.2" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    eye:     '<path d="M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12z" stroke="#fff" stroke-width="1.7" fill="none"/><circle cx="12" cy="12" r="2.4" fill="#fff"/>',
    trash:   '<path d="M5.5 7h13M9.5 7V5.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1V7M7 7l.8 11.3c.1.7.6 1.2 1.3 1.2h5.8c.7 0 1.2-.5 1.3-1.2L17 7" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    gear:    '<circle cx="12" cy="12" r="3" stroke="#fff" stroke-width="1.7" fill="none"/><path d="M12 3.5v2.6M12 17.9v2.6M20.5 12h-2.6M6.1 12H3.5M18 6l-1.8 1.8M7.8 16.2L6 18M18 18l-1.8-1.8M7.8 7.8L6 6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
    moon:    '<path d="M19.6 14.3A8 8 0 0 1 9.7 4.4 8 8 0 1 0 19.6 14.3z" fill="#fff"/>',
    sun:     '<circle cx="12" cy="12" r="4" fill="#fff"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6L6 18M18 18l-1.4-1.4M7.4 7.4L6 6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
    half:    '<circle cx="12" cy="12" r="7.5" stroke="#fff" stroke-width="1.7" fill="none"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="#fff"/>',
    flip:    '<path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M17.3 3.6l-.5 4 4-.6" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    play:    '<path d="M8.5 5.8v12.4L18.5 12z" fill="#fff"/>',
    pause:   '<rect x="7" y="5.8" width="3.6" height="12.4" rx="1.2" fill="#fff"/><rect x="13.4" y="5.8" width="3.6" height="12.4" rx="1.2" fill="#fff"/>',
    reply:   '<path d="M9.5 6L4.5 11l5 5" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 11h8.2a5.3 5.3 0 0 1 5.3 5.3v1.4" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
    close:   '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    chevron: '<path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    image:   '<rect x="4" y="5" width="16" height="14" rx="2" stroke="#fff" stroke-width="1.7" fill="none"/><circle cx="9" cy="10" r="1.7" fill="#fff"/><path d="M5 17.5l4.5-4.5 3 3 3-3L19 16.5" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    check:   '<path d="M5 12.6l4.4 4.4L19 7.4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    bulb:    '<path d="M12 4a5.6 5.6 0 0 1 3.2 10.2c-.7.5-1.2 1.2-1.2 2v.3h-4v-.3c0-.8-.5-1.5-1.2-2A5.6 5.6 0 0 1 12 4z" fill="#fff"/><path d="M10.3 19.5h3.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
    broadcast:'<circle cx="12" cy="12" r="2" fill="#fff"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    seal:    '<path d="M12 2.8l2 1.7 2.6-.3 1 2.4 2.4 1-.3 2.6 1.7 2-1.7 2 .3 2.6-2.4 1-1 2.4-2.6-.3-2 1.7-2-1.7-2.6.3-1-2.4-2.4-1 .3-2.6-1.7-2 1.7-2-.3-2.6 2.4-1 1-2.4 2.6.3z" fill="#2f7dff"/><path d="M8.6 12.2l2.4 2.4 4.6-4.8" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    // лица для реакций (рисуются поверх цветного кружка)
    faceLaugh: '<path d="M8.6 9.6l1.9 1.2M15.4 9.6l-1.9 1.2" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M7.8 13.2a4.4 4.4 0 0 0 8.4 0z" fill="#fff"/>',
    faceWow:   '<circle cx="9.4" cy="10" r="1.4" fill="#fff"/><circle cx="14.6" cy="10" r="1.4" fill="#fff"/><ellipse cx="12" cy="14.8" rx="2.3" ry="2.8" fill="#fff"/>',
    faceSad:   '<circle cx="9.4" cy="10.2" r="1.4" fill="#fff"/><circle cx="14.6" cy="10.2" r="1.4" fill="#fff"/><path d="M8.6 16a4.6 4.6 0 0 1 6.8 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M16.4 13.4c1 1.3 1.6 2.3 1.6 3.1a1.6 1.6 0 0 1-3.2 0c0-.8.6-1.8 1.6-3.1z" fill="#fff"/>',
    faceBlown: '<circle cx="9.2" cy="9.8" r="1.5" fill="#fff"/><circle cx="14.8" cy="9.8" r="1.5" fill="#fff"/><path d="M9 14.6c1.9-1.7 4.1-1.7 6 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M12 2.6l.9 2 2-.7-.6 2.1 2.1.5-1.6 1.5" fill="#fff"/>',
    thumb:     '<path d="M7.3 10.8v7M7.3 11.6l2.9-6c.6-.4 1.5-.1 1.7.7l.4 2.9h3.9c1 0 1.8 1 1.5 2l-1.2 4.3c-.2.7-.8 1.1-1.5 1.1H7.3" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  // плитка-аватарка: градиентный скруглённый квадрат + белый глиф
  function tile(g, glyph, cls) {
    const id = 'bgi' + (++uid);
    return `<svg class="ticon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${G[g][0]}"/><stop offset="1" stop-color="${G[g][1]}"/></linearGradient></defs><rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="url(#${id})"/>${glyph}</svg>`;
  }

  // кружок-аватарка (реакции): градиентный круг + глиф
  function orb(g, glyph, cls) {
    const id = 'bgo' + (++uid);
    return `<svg class="oicon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${G[g][0]}"/><stop offset="1" stop-color="${G[g][1]}"/></linearGradient></defs><circle cx="12" cy="12" r="10" fill="url(#${id})"/>${glyph}</svg>`;
  }

  // монохромный глиф под currentColor (для текстовых кнопок)
  function mono(glyph, cls) {
    return `<svg class="micon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg>`;
  }

  /* мини-аватарки заслуг — по ключу бейджа с сервера */
  const BICONS = {
    first_post: tile('mint', P.sprout),
    writer_10:  tile('azure', P.pen),
    clipper:    tile('violet', P.clapper),
    director:   tile('rose', P.camera),
    voice:      tile('cyan', P.mic),
    loved_50:   tile('rose', P.heart),
    viral_1000: tile('amber', P.flame),
    chatty:     tile('azure', P.chat),
    moment:     tile('violet', P.sparkle),
    verified:   tile('mint', P.envelope),
  };

  /* реакции: эмодзи-ключ из БД -> аватарка (хранение не меняется) */
  const RX = {
    '❤️': orb('rose', P.heart),
    '🔥': orb('amber', P.flame),
    '😂': orb('amber', P.faceLaugh),
    '😮': orb('cyan', P.faceWow),
    '👍': orb('azure', P.thumb),
    '😢': orb('violet', P.faceSad),
    '🤯': orb('violet', P.faceBlown),
    '💚': orb('mint', P.heart),
  };

  function rxIconHTML(emoji, cls) {
    const svg = RX[emoji];
    return svg ? svg.replace('class="oicon', `class="oicon${cls ? ' ' + cls : ''} `) : (emoji || '');
  }

  /* UI-иконки */
  const I = {
    trophy:  tile('amber', P.trophy),
    robot:   tile('azure', P.robot),
    palette: tile('violet', P.palette),
    check:   mono(`<path d="M5 12.6l4.4 4.4L19 7.4" stroke="#2bb673" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    bulb:    mono(`<path d="M12 4a5.6 5.6 0 0 1 3.2 10.2c-.7.5-1.2 1.2-1.2 2v.3h-4v-.3c0-.8-.5-1.5-1.2-2A5.6 5.6 0 0 1 12 4z" fill="#ffb066"/><path d="M10.3 19.5h3.4" stroke="#ffb066" stroke-width="1.6" stroke-linecap="round"/>`),
    flame:   mono(`<path d="M12 4.4c1 2.7 4.6 4.5 4.6 8.2a4.6 4.6 0 0 1-9.2 0c0-1.7.7-3 1.6-4.2.3 1.1.9 1.9 1.7 2.3-.4-2.2.2-4.4 1.3-6.3z" fill="currentColor"/>`),
    trend:   mono(`<path d="M4 16.5l4.8-4.8 3.4 3.4L18.5 9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.8 8.6h4.2v4.2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    sprout:  mono(`<path d="M12 18.5v-5.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M12 13C8.8 13 7 11.2 6.4 8.2c3.1-.1 5.3 1.3 5.6 4.8z" fill="currentColor"/>`),
    chart:   mono(`<rect x="5" y="12" width="3.4" height="7" rx="1" fill="currentColor"/><rect x="10.3" y="8" width="3.4" height="11" rx="1" fill="currentColor"/><rect x="15.6" y="4.5" width="3.4" height="14.5" rx="1" fill="currentColor"/>`),
    mic:     mono(`<rect x="9.6" y="4.5" width="4.8" height="9" rx="2.4" fill="currentColor"/><path d="M7 11.5a5 5 0 0 0 10 0M12 16.8v2.7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>`),
    image:   mono(`<rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="9" cy="10" r="1.7" fill="currentColor"/><path d="M5 17.5l4.5-4.5 3 3 3-3L19 16.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    reply:   mono(`<path d="M9.5 6L4.5 11l5 5" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 11h8.2a5.3 5.3 0 0 1 5.3 5.3v1.4" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>`),
    play:    mono(`<path d="M8.5 5.8v12.4L18.5 12z" fill="currentColor"/>`),
    pause:   mono(`<rect x="7" y="5.8" width="3.6" height="12.4" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.8" width="3.6" height="12.4" rx="1.2" fill="currentColor"/>`),
    close:   mono(P.close),
    chevron: mono(P.chevron),
    flip:    mono(P.flip.replace(/#fff/g, 'currentColor')),
    gear:    mono(P.gear.replace(/#fff/g, 'currentColor')),
    moon:    mono(P.moon.replace(/#fff/g, 'currentColor')),
    sun:     mono(P.sun.replace(/#fff/g, 'currentColor')),
    half:    mono(P.half.replace(/#fff/g, 'currentColor')),
    trash:   mono(P.trash.replace(/#fff/g, 'currentColor')),
    eye:     mono(P.eye.replace(/#fff/g, 'currentColor')),
    sparkle: mono(P.sparkle.replace(/#fff/g, 'currentColor')),
    clapper: mono(P.clapper.replace(/#fff/g, 'currentColor')),
    heart:   mono(P.heart.replace(/#fff/g, 'currentColor')),
    chat:    mono(P.chat.replace(/#fff/g, 'currentColor')),
    envelope:mono(P.envelope.replace(/#fff/g, 'currentColor')),
    broadcast:mono(P.broadcast.replace(/#fff/g, 'currentColor')),
    seal:    mono(P.seal),
  };

  function iconEl(name, cls) {
    const span = document.createElement('span');
    span.className = 'icon' + (cls ? ' ' + cls : '');
    span.innerHTML = I[name] || '';
    return span;
  }

  window.BLOOP_ICONS = { I, BICONS, rxIconHTML, iconEl, tile, orb };
})();
