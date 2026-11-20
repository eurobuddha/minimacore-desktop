/*
 * wordentry.js — guided entry of a 24-word seed phrase: one box per word. A port of the phone's WordEntry
 * (apks/base com/eurobuddha/account/WordEntry.java) and SeedEntry, in the node's context: a free-form phrase
 * ("My phrase is not 24 list words") is allowed, and one made only of list words asks which form to use.
 *
 * Minima phrases carry NO BIP39 checksum (24 independent words), so each word is checked and the phrase never
 * is. The list is Minima's own (org.minima.utils.BIP39.WORD_LIST: the standard English 2048, standard order).
 *
 * Nothing typed here is stored, logged or sent anywhere: the caller reads phrase() once and passes it on.
 * Dual-loaded: a browser global for the screens, require() for scripts/wordentry-test.cjs.
 */
(function (root) {
  var L = typeof I18N !== "undefined" ? I18N : require("./i18n.js");   // the languages (L.t, L.th); in a test, the same helper by require
  var WORDS = Object.freeze("abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" "));   // frozen: no script can change a word of the list seeds are made from
  var SET = new Set(WORDS), N = 24, ANY_MIN = 16;

  // ---- pure helpers ----
  /** Lower-case letters only: anything else can never be part of a word. */
  function letters(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z]/g, ""); }
  /** The words in pasted text, in order: numbers, line breaks, commas and full stops separate words. */
  function splitPasted(raw) { return String(raw == null ? "" : raw).toLowerCase().split(/[^a-z]+/).filter(Boolean); }
  function isWord(w) { return SET.has(w); }
  /** Up to `max` words starting with `prefix` (none for an empty prefix). */
  function matches(prefix, max) {
    var out = [];
    if (!prefix) return out;
    for (var i = 0; i < WORDS.length && out.length < max; i++) if (WORDS[i].indexOf(prefix) === 0) out.push(WORDS[i]);
    return out;
  }
  /** The 24 words joined by single spaces, or null while any box is empty or not a word. */
  function join(words) { return words.length === N && words.every(isWord) ? words.join(" ") : null; }
  /** Minima's own form of list words: capitals, single spaces (what BIP39.cleanSeedPhrase returns, and what a node shows). */
  function minimaForm(words) { return splitPasted(words).join(" ").toUpperCase(); }
  /** 12 or more letter-runs, every one a list word: the caller asks "Minima's form or exactly as typed". */
  function allListWords(phrase) { var t = splitPasted(phrase); return t.length >= 12 && t.every(isWord); }
  /**
   * Why a free-form phrase cannot be used, or null. It is for RESTORING a wallet made with exactly that phrase.
   * Refused: under 16 characters; a leading "-" (the node would read it as an option); characters the node's
   * command parser splits, strips or reads as JSON; and list words with a mistake in them (12 to 30 runs of
   * which three quarters are list words or unique prefixes), which belong in the boxes. A phrase made ONLY of
   * list words is allowed here, because older apps hashed typed words as typed.
   */
  function anyPhraseProblem(phrase) {
    var t = String(phrase == null ? "" : phrase).trim();
    if (t.length < ANY_MIN) return L.t("A phrase needs at least {n} characters.", { n: ANY_MIN });
    if (t.charAt(0) === "-") return L.t("A phrase cannot start with \"-\".");
    if (/[";:\[\]{}\\\u0000-\u001f\u007f-\u009f]/.test(t)) return L.t("A phrase restored by the node cannot contain \" ; : [ ] { } \\ or a line break.");
    var tok = splitPasted(t), n = tok.length, listish = 0, allWords = n > 0;
    tok.forEach(function (w) {
      if (isWord(w)) listish++;
      else { allWords = false; if (w.length >= 4 && matches(w, 2).length === 1) listish++; }
    });
    if (n >= 12 && n <= 30 && listish * 4 >= n * 3 && !allWords) return L.t("This looks like list words with a mistake in them: check them in the word boxes.");
    return null;
  }

  // ---- the boxes ----
  /**
   * create(host, { anyPhrase, clearClipboard }) → { phrase(), problem(), isAnyPhrase(), clear() }
   * phrase(): boxes → the 24 words joined by single spaces (lower case); free-form → the phrase, trimmed, once
   * both copies match and it is allowed. null until then; problem() says why.
   */
  function create(host, opts) {
    opts = opts || {};
    var tail = "", tailBox = -1, tailUntil = 0, hidden = false, anyMode = false;
    var cells = "";
    for (var i = 0; i < N; i++) cells += '<input class="we-box" data-i="' + i + '" placeholder="' + (i + 1) + '" aria-label="' + L.th("Word {n}", { n: i + 1 }) + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />';
    host.innerHTML = '<div class="we"><div class="we-top"><button type="button" class="we-btn" data-we="hide">' + L.th("Hide words") + '</button><button type="button" class="we-btn" data-we="clear">' + L.th("Clear all") + '</button></div>' +
      '<div class="we-words"><div class="we-grid">' + cells + '</div><div class="we-sugg"></div><div class="we-count" role="status"></div></div>' +
      (opts.anyPhrase ? '<div class="we-any" hidden><p class="we-warn">' + L.th("Only use this to RESTORE a wallet that was made with exactly this phrase. Anyone who guesses a short or well-known phrase can take everything on it. Capital letters, spaces and punctuation all count: type it exactly as it was made, twice.") + '</p>' +
        '<input class="we-anyf" placeholder="' + L.th("Your phrase") + '" aria-label="' + L.th("Your phrase") + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" /><input class="we-anyf" placeholder="' + L.th("The same phrase again") + '" aria-label="' + L.th("The same phrase again") + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>' +
        '<button type="button" class="we-toggle" data-we="any">' + L.th("My phrase is not 24 list words") + '</button>' : "") + '</div>';
    var q = function (sel) { return host.querySelector(sel); };
    var boxes = Array.prototype.slice.call(host.querySelectorAll(".we-box")), prev = boxes.map(function () { return 0; });
    var any = Array.prototype.slice.call(host.querySelectorAll(".we-anyf")), sugg = q(".we-sugg"), count = q(".we-count");

    function style(i) {
      var v = boxes[i].value;
      boxes[i].dataset.state = !v ? "" : isWord(v) ? "ok" : matches(v, 1).length ? "" : "bad";
    }
    function refresh() {
      var ok = boxes.filter(function (b) { return isWord(b.value); }).length;
      count.textContent = ok === N ? L.t("All 24 words entered") : L.t("{n} of 24 words", { n: ok });
      count.dataset.state = ok === N ? "ok" : "";
    }
    function showSuggestions(i) {
      sugg.innerHTML = "";
      if (hidden) return;
      matches(boxes[i].value, 8).forEach(function (w) {
        var b = document.createElement("button"); b.type = "button"; b.className = "we-btn we-btn--s"; b.textContent = w;
        b.onmousedown = function (e) { e.preventDefault(); commit(i, w); };
        sugg.appendChild(b);
      });
    }
    /** Forward only: wrapping to an earlier empty box let a finished word's typed tail land there. Returns the box now focused, -1 when none. */
    function focusNextProblem(from) {
      for (var k = from + 1; k < N; k++) if (!isWord(boxes[k].value)) { boxes[k].focus(); showSuggestions(k); return k; }
      if (boxes[from]) boxes[from].blur();
      sugg.innerHTML = "";
      return -1;
    }
    function commit(i, w) { boxes[i].value = w; prev[i] = w.length; style(i); refresh(); return focusNextProblem(i); }
    /** Pasted words. A whole phrase (24 or more) always fills from box 1; words are never dropped: too many is refused with the count. */
    function spread(i, words) {
      var start = words.length >= N ? 0 : i;
      if (opts.clearClipboard) opts.clearClipboard();   // a pasted phrase must not stay on the clipboard
      if (start + words.length > N) {
        boxes[i].value = ""; prev[i] = 0; style(i);
        count.textContent = start === 0 ? L.t("{n} words pasted, but {fit} fit. Nothing was filled in: paste exactly the 24 words.", { n: words.length, fit: N })
          : L.t("{n} words pasted, but {fit} fit from box {box}. Nothing was filled in: paste exactly the 24 words.", { n: words.length, fit: N - i, box: i + 1 });
        count.dataset.state = "bad";
        return;
      }
      var k = start;
      words.forEach(function (w) {
        var m = matches(w, 2), v = isWord(w) ? w : m.length === 1 ? m[0] : w;   // a unique prefix completes, as when typing
        boxes[k].value = v; prev[k] = v.length; style(k); k++;
      });
      tail = ""; tailBox = -1;
      focusNextProblem(k - 1); refresh();
    }
    function onEdit(i) {
      var raw = boxes[i].value, pasted = splitPasted(raw);
      if (pasted.length > 1) { spread(i, pasted); return; }   // pasted words, or a typed space
      if (i === tailBox && tail && Date.now() < tailUntil) {
        var typed = letters(raw);
        if (typed && tail.indexOf(typed) === 0) {              // still typing the word that just completed: drop it
          tail = tail.slice(typed.length); tailUntil = Date.now() + 1500;
          if (!tail) tailBox = -1;
          boxes[i].value = ""; prev[i] = 0; style(i);
          return;
        }
      }
      tail = ""; tailBox = -1;
      var v = letters(raw);
      if (v !== raw) boxes[i].value = v;
      var grew = v.length > prev[i];
      prev[i] = v.length;
      var m = matches(v, 2);
      // A word is certain once only one matches. Only while TYPING: completing on a backspace would make a finished word impossible to edit.
      if (grew && m.length === 1) {
        tail = m[0].slice(Math.min(v.length, m[0].length));
        tailBox = commit(i, m[0]); tailUntil = Date.now() + 1500;
        return;
      }
      style(i); showSuggestions(i); refresh();
    }
    boxes.forEach(function (b, i) {
      b.addEventListener("input", function () { onEdit(i); });
      b.addEventListener("focus", function () { showSuggestions(i); });
    });
    function setHidden(on) {
      hidden = on;
      q('[data-we="hide"]').textContent = on ? L.t("Show words") : L.t("Hide words");
      boxes.concat(any).forEach(function (b) { b.type = on ? "password" : "text"; });
      if (on) sugg.innerHTML = "";
    }
    function clear() {
      boxes.forEach(function (b, i) { b.value = ""; prev[i] = 0; style(i); });
      any.forEach(function (a) { a.value = ""; });
      setHidden(false); tail = ""; tailBox = -1; sugg.innerHTML = "";
      refresh();
    }
    function setAny(on) {
      anyMode = on;
      q(".we-words").hidden = on; q(".we-any").hidden = !on;
      q('[data-we="any"]').textContent = on ? L.t("Use the 24 word boxes instead") : L.t("My phrase is not 24 list words");
      if (on) { any[0].focus(); sugg.innerHTML = ""; }
    }
    host.querySelector(".we").addEventListener("click", function (e) {
      var b = e.target.closest("[data-we]"); if (!b) return;
      if (b.dataset.we === "hide") setHidden(!hidden);
      else if (b.dataset.we === "clear") { clear(); (anyMode ? any[0] : boxes[0]).focus(); }
      else setAny(!anyMode);
    });
    refresh();

    function firstProblem() { for (var k = 0; k < N; k++) if (!isWord(boxes[k].value)) return k + 1; return 0; }
    return {
      isAnyPhrase: function () { return anyMode; },
      phrase: function () {
        if (anyMode) { var a = any[0].value.trim(); return a === any[1].value.trim() && anyPhraseProblem(a) == null ? a : null; }
        return join(boxes.map(function (b) { return b.value; }));
      },
      problem: function () {
        if (anyMode) { var a = any[0].value.trim(), why = anyPhraseProblem(a); return why || (a === any[1].value.trim() ? null : L.t("The two copies of the phrase are not the same.")); }
        var n = firstProblem();
        return n === 0 ? null : L.t("Word {n} is empty or not one of the 2048 words.", { n: n });
      },
      clear: clear
    };
  }

  var API = { WORDS: WORDS, letters: letters, splitPasted: splitPasted, isWord: isWord, matches: matches, join: join, minimaForm: minimaForm,
              allListWords: allListWords, anyPhraseProblem: anyPhraseProblem, create: create };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (root) root.WordEntry = API;
})(typeof window !== "undefined" ? window : null);
