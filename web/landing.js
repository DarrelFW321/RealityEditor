// Landing page behaviour: floating model cards, the before/after slider, and quiet scroll
// reveals. The model renders come from catalog/generated/*.glb.

(() => {
  /* ---------------------------------------------------------------- */
  /* Hero: four renders framing the headline                           */
  /* ---------------------------------------------------------------- */

  const CARDS = [
    { id: 'three-seat-sofa', l: 6, t: 16, r: -6 },
    { id: 'tripod-floor-lamp', l: 15, t: 60, r: 5 },
    { id: 'linen-armchair', l: 80, t: 13, r: 6 },
    { id: 'potted-plant', l: 72, t: 59, r: -5 },
  ];

  const stage = document.getElementById('floatStage');
  CARDS.forEach((c, i) => {
    const f = document.createElement('figure');
    f.className = 'fcard';
    f.style.setProperty('--l', `${c.l}%`);
    f.style.setProperty('--t', `${c.t}%`);
    f.style.setProperty('--r', `${c.r}deg`);
    f.style.setProperty('--delay', `${i * -1.7}s`);
    f.style.setProperty('--in', `${0.15 + i * 0.1}s`);
    f.innerHTML = `<div class="fcard-in"><img src="img/furniture/${c.id}.png" alt="" /></div>`;
    stage.appendChild(f);
  });

  // A slight parallax as the pointer moves over the hero.
  const hero = document.querySelector('.hero');
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    stage.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    stage.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  });

  /* ---------------------------------------------------------------- */
  /* How it works                                                      */
  /* ---------------------------------------------------------------- */

  // Two of the five cannot be photographed - the constraint check and the exported
  // plan are drawings, so they are drawn rather than faked with a stand-in photo.
  const STEPS = [
    {
      img: 'img/room-real-empty.jpg',
      alt: 'A real empty room, photographed',
      title: 'Start with your room',
      body: 'A real room, as it is. Sweep it once with your phone and the scan begins.',
    },
    {
      img: 'img/room-empty.jpg',
      alt: 'The same room reduced to measured geometry',
      title: 'It becomes measurements',
      body: 'Walls, floor, doorways and openings, in metres. From here on it is geometry, not pixels.',
    },
    {
      img: 'img/step-check.svg',
      alt: 'A plan showing a sofa moved clear of the door swing',
      title: 'Everything is checked against them',
      body: 'Ask for a sofa and it is tested against the real measurements: what it would hit, whether the door still opens, whether it fits at all.',
    },
    {
      img: 'img/room-full.jpg',
      alt: 'The measured room with furniture placed in it',
      title: 'Furniture lands where it fits',
      body: 'Placed, or moved with a reason, or refused. Nothing is committed that would not physically work.',
    },
    {
      img: 'img/room-ar.jpg',
      alt: 'The real room again, with the furniture drawn into the camera view',
      title: 'And back into the real room',
      body: 'Drawn into the live camera, standing on your actual floor, in front of your actual window.',
    },
    {
      img: 'img/step-plan.svg',
      alt: 'A to-scale floor plan of the finished room',
      title: 'Take the plan with you',
      body: 'Export it as a to-scale PDF floor plan \u2014 the room as you edited it, not as you scanned it.',
    },
  ];

  const nodes = [...document.querySelectorAll('.flow-node')];
  const shot = document.getElementById('flowImg');
  const flowTitle = document.getElementById('flowTitle');
  const flowBody = document.getElementById('flowBody');

  // Decode ahead of the click so switching steps does not flash an empty frame.
  STEPS.forEach((s) => {
    const pre = new Image();
    pre.src = s.img;
  });

  nodes.forEach((node) =>
    node.addEventListener('click', () => {
      const step = STEPS[Number(node.dataset.step)];
      if (!step) return;
      nodes.forEach((n) => n.classList.toggle('is-on', n === node));
      shot.src = step.img;
      shot.alt = step.alt;
      flowTitle.textContent = step.title;
      flowBody.textContent = step.body;
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Before / after                                                    */
  /* ---------------------------------------------------------------- */

  const SHOW = {
    place: {
      a: 'room-empty', b: 'room-full', tags: ['Before', 'After'],
      title: 'Speak a room into shape.',
      sub: 'It measures your room first, so whatever lands actually fits.',
    },
    restyle: {
      a: 'room-full', b: 'room-warm', tags: ['Daylight oak', 'Warm walnut'],
      title: 'Restyle it without moving a thing.',
      sub: 'The look changes. Nothing moves.',
    },
    ar: {
      a: 'room-real-empty', b: 'room-ar', tags: ['Your empty room', 'Through the phone'],
      title: 'Not a render. Your room.',
      sub: 'One real room, before and after. The floor, the window and the light never changed.',
    },
  };

  const compare = document.getElementById('compare');
  const range = document.getElementById('compareRange');
  range.addEventListener('input', () => compare.style.setProperty('--pos', `${range.value}%`));

  document.querySelectorAll('.toggle').forEach((btn) =>
    btn.addEventListener('click', () => {
      const s = SHOW[btn.dataset.show];
      document.querySelectorAll('.toggle').forEach((b) => b.classList.toggle('on', b === btn));
      document.getElementById('compareA').src = `img/${s.a}.jpg`;
      document.getElementById('compareB').src = `img/${s.b}.jpg`;
      document.getElementById('tagA').textContent = s.tags[0];
      document.getElementById('tagB').textContent = s.tags[1];
      document.getElementById('compareTitle').textContent = s.title;
      document.getElementById('compareSub').textContent = s.sub;
      // Sweep the divider in from the left so the change is visible.
      let p = 10;
      const sweep = setInterval(() => {
        p += 4;
        range.value = p;
        compare.style.setProperty('--pos', `${p}%`);
        if (p >= 50) clearInterval(sweep);
      }, 16);
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Scroll reveals (the hero waits for the intro to clear)            */
  /* ---------------------------------------------------------------- */

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document
    .querySelectorAll('.hero-copy > *, .flow-sec > *, .compare-sec > *, .editor-sec > *, .quote-sec blockquote, .closing > *')
    .forEach((el) => {
      el.classList.add('reveal');
      const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
      el.style.setProperty('--d', `${sibs.indexOf(el) * 0.08}s`);
    });

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  document.querySelectorAll('.reveal').forEach((el) => (reduce ? el.classList.add('in') : io.observe(el)));

  const introDone = () => stage.classList.add('live');
  if (document.body.classList.contains('intro-active')) document.addEventListener('dex:intro-done', introDone, { once: true });
  else introDone();
})();
