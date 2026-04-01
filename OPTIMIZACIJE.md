# Three.js Optimizacije — Pregled

## Problem 1 — Nema GLB cachinga

**Šta je bio problem:**  
Svaki modul zvao je `new GLTFLoader().load(url)` iznova, čak i ako je isti GLB fajl već bio učitan. Sa 10 modula istog tipa → 10 HTTP requestova za isti fajl.

**Šta je urađeno:**  
Dodat `glbCache: Map<string, THREE.Group>` na nivou modula (van komponente). Pre svakog loada proverava se cache. Ako postoji — koristi se odmah. Ako ne — učita se, sačuva u cache, i tek onda koristi.

**Kako proveriti:**  
Chrome DevTools → **Network** tab → filter po `.glb`. Dodaj 5 modula istog tipa. Trebalo bi da se pojavi samo **1 request** po GLB fajlu, bez obzira na broj modula.

---

## Problem 2 — Nema memory cleanup-a

**Šta je bio problem:**  
Kad se modul ukloni sa scene, `THREE.Group` sa svim `BufferGeometry` i `Material` instancama ostajao je alociran u GPU memoriji. Svako brisanje modula = leak.

**Šta je urađeno:**  
Dodata `disposeObject3D(obj)` helper funkcija koja traversuje ceo subtree i poziva `.dispose()` na svakom `geometry` i `material`. Poziva se eksplicitno pri brisanju modula u diff effectu i pri teardownu scene.

**Kako proveriti:**  
Chrome DevTools → **Memory** tab → snimiti Heap Snapshot. Dodati 10 modula, pa ih sve obrisati. Snimiti novi snapshot i uraditi **Comparison** — broj `THREE.BufferGeometry` instanci treba da se vrati na početni nivo.

---

## Problem 3 — GLTFLoader kreiran unutar forEach petlje

**Šta je bio problem:**  
`new GLTFLoader()` se zvao unutar `modules.forEach(...)` → novi loader objekat za svaki modul, svaki sa sopstvenim internim state-om i potencijalnom ponovnom inicijalizacijom.

**Šta je urađeno:**  
`gltfLoader` pomeren na nivo modula (van komponente i van petlje) kao jedna globalna instanca koja se deli za sve module.

**Kako proveriti:**  
Pregledati kod — postoji tačno jedna `const gltfLoader = new GLTFLoader()` deklaracija van sve komponente, na vrhu fajla.

---

## Problem 4 — Cela scena se rebuild-uje na svaki state update

**Šta je bio problem:**  
Jedan `useEffect([modules, cols, rows])` rušio je celu Three.js scenu (renderer, kamera, svetla, floor) i gradio je od nule svaki put kad se bilo koji modul promeni (dodavanje, brisanje, promena opcija, pomeranje).

**Šta je urađeno:**  
Splittovano u dva effecta:

- `useEffect([cols, rows])` — full scene init. Pokreće se samo kad se menja veličina grida (retko).
- `useEffect([modules])` — lightweight diff. Iterira modules array, uklanja uklonjene, updateuje postojeće (samo pozicija/rotacija/vidljivost), dodaje nove. Scena se ne diže i ne gradi iznova.

**Kako proveriti:**  
Dodati `console.time('modules-diff')` / `console.timeEnd('modules-diff')` oko diff effecta. Bez optimizacije: ~500–1000ms po akciji. Sa optimizacijom: <5ms.  
Visual provjera: kamera i anotacije **ne resetuju se** nakon dodavanja/brisanja modula.

---

## Problem 5 — `gltf.scene.clone()` kopira celu geometriju

**Šta je bio problem:**  
Sa 20 istih modula, svaki je imao svoju kopiju svih geometry buffera u JS heapu (iako Chrome/GPU interno može da ih deli).

**Šta je urađeno:**  
`THREE.Object3D.clone()` već deli `BufferGeometry` i `Material` reference između klonova — nije potrebna posebna implementacija. Dodatno, dodat `glbMetaCache: Map<string, GlbMeta>` koji kešira `{ uniformScale, px, py, pz }` po GLB tipu, tako da se Box3 kalkulacija radi samo jednom po tipu modula.

**Kako proveriti:**  
Chrome DevTools → Memory → Heap Snapshot → tražiti `BufferGeometry`. Sa 20 identičnih modula, broj `BufferGeometry` instanci treba da ostane isti kao sa 1 modulom (deljene reference).

---

## Problem 6 — castShadow/receiveShadow traverse na svakom renderu

**Šta je bio problem:**  
`modulModel.traverse(child => { child.castShadow = true; ... })` pozivao se za svaki novi modul, čak i kad je GLB već bio u cacheu. Sa 20 modula = 20 traversala istog subtreea.

**Šta je urađeno:**  
Shadow flagovi se postavljaju jednom na izvorni `gltf.scene` odmah posle učitavanja (pre nego što se sačuva u `glbCache`). `Object3D.clone()` kopira `castShadow` i `receiveShadow` na svaki node automatski. Svaki naknadni klon dobija tačne vrednosti bez ijednog traversala.

**Kako proveriti:**  
U `addModuleToScene` — nema više `traverse` poziva za shadow. Potražiti `castShadow` u kodu — jedino mesto je unutar `gltfLoader.load` callback-a, pre `glbCache.set`.

---

## Problem 7 — Višestruke Box3 kalkulacije po modulu

**Šta je bio problem:**  
Za prvi load svakog GLB tipa pozivalo se `new THREE.Box3().setFromObject(model)` **dva puta**:
1. Da se izmeri originalna veličina (za scale)
2. Da se izmeri skalirana veličina (za pivot/centar)

Svaki `setFromObject` traversuje ceo geometry subtree i računa AABB.

**Šta je urađeno:**  
Eliminisan drugi `Box3` poziv. Pošto je scale uniforman (isti faktor na svim osama), važi:

$$\text{center}_\text{scaled} = \text{center}_0 \times s \qquad \text{min.y}_\text{scaled} = \text{min.y}_0 \times s$$

`px`, `py`, `pz` se računaju direktno iz prvog `bbox0` i `uniformScale`. Rezultat se kešira u `glbMetaCache` — za svaki naredni modul istog tipa, ni jedan `Box3` se ne računa.

**Kako proveriti:**  
U funkciji `addModuleToScene` — postoji tačno jedan `new THREE.Box3()` poziv, unutar `if (!glbMetaCache.has(metaKey))` bloka.

---

## Problem 8 — Deprecated browser warnings

**Šta je bio problem:**  
Dva upozorenja u browser konzoli:
1. `THREE.WebGLShadowMap: PCFSoftShadowMap has been deprecated` — Three.js r163+ uklonio tu varijantu
2. `[Deprecation] The keyword 'slider-vertical' specified to an 'appearance' property is not standardized`

**Šta je urađeno:**  
- `THREE.PCFSoftShadowMap` → `THREE.PCFShadowMap`
- Uklonjen `appearance: 'slider-vertical'` i `WebkitAppearance: 'slider-vertical'` sa oba range input slidera. Slideri su već koristili `writingMode: 'vertical-lr'` i `direction: 'rtl'` što je standardni moderan način — stari `appearance` property je bio redundantan.

**Kako proveriti:**  
Otvoriti app → F12 → Console. Treba da bude čisto bez tih upozorenja. Vertikalni slideri za sunce i visinu treba da i dalje rade normalno.
