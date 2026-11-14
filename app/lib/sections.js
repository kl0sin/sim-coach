// Named sections of known tracks, as distance ranges (km) along the track model.
// The ranges below were assigned by matching the recorded geometry to the known order of
// the Nordschleife's sections (anchors: Aremberg, Breidscheid at the lowest point, Bergwerk,
// the 200-degree Karussell, Kleines Karussell). Boundaries are approximate; edit freely.
const NORDSCHLEIFE_TOURIST = [
  [0.00, 'Döttinger Höhe'], [0.55, 'Tiergarten'], [0.80, 'Hohenrain'], [1.10, 'T13'], [1.28, 'Hatzenbach'],
  [2.40, 'Hocheichen'], [2.70, 'Quiddelbacher Höhe'], [3.10, 'Flugplatz'], [3.80, 'Schwedenkreuz'], [4.70, 'Aremberg'],
  [5.00, 'Fuchsröhre'], [5.90, 'Adenauer Forst'], [6.50, 'Metzgesfeld'], [7.35, 'Kallenhard'], [7.62, 'Miss-Hit-Miss'],
  [8.20, 'Wehrseifen'], [8.60, 'Breidscheid'], [9.02, 'Ex-Mühle'], [9.40, 'Lauda-Links'], [9.75, 'Bergwerk'],
  [10.10, 'Kesselchen'], [11.70, 'Mutkurve'], [12.05, 'Klostertal'], [12.40, 'Steilstrecke'], [12.80, 'Karussell'],
  [13.20, 'Hohe Acht'], [14.10, 'Wippermann'], [14.80, 'Eschbach'], [15.05, 'Brünnchen'], [15.52, 'Eiskurve'],
  [15.80, 'Pflanzgarten'], [17.20, 'Schwalbenschwanz'], [17.75, 'Kleines Karussell'], [18.05, 'Galgenkopf'],
  [18.60, 'Döttinger Höhe'], [20.00, 'Zjazd na parking']
];

function table(lap) {
  if (/n.rburgring/i.test(lap.track) && /touristen/i.test(lap.track_config)) return NORDSCHLEIFE_TOURIST;
  return null;
}

// Section name at a distance along the track (metres), or '' when the track is not known.
function nameAt(lap, s) {
  const t = table(lap);
  if (!t) return '';
  let name = '';
  for (const [km, n] of t) { if (s / 1000 >= km) name = n; else break; }
  return name;
}

module.exports = { nameAt };
