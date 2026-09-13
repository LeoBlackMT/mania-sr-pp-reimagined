# Reference C# Sources — bancho (ppy/osu lazer) mania & sunny (author's C# port)

Reconnaissance for the Rust "multi-algorithm osu!mania PP comparison engine". Everything below was read from thetwo trees on disk; nothing is paraphrased from memory. Where something does not exist the text says **NOT FOUND**and names where it was searched.

## Provenance & conventions

| id | repo root | notes |
|----|-----------|-------|
| **A** | `C:\Users\Leo_BlackLT\Desktop\Dev\files\osu\osu-master` | full ppy/osu lazer tree. No `.git` (`git log` → "not a git repository") → **no pinned SHA**. Has `ManiaScoreMultiplierCalculator`, `ManiaModScoreV2`, `ManiaModDualStages` → recent master. |
| **B** | `C:\Users\Leo_BlackLT\Desktop\Dev\files\osu\osu-author-port` | full osu fork with the author's sunny port grafted in. No `.git`, no CHANGELOG/version file → **upstream revision NOT FOUND**. Older base than A: no `ManiaScoreMultiplierCalculator`, no `ManiaModScoreV2`, and the old `clockRate`-parameter `DifficultyCalculator` API (`B:osu.Game/Rulesets/Difficulty/DifficultyCalculator.cs:273,281,291`). |

Paths are **relative to the respective repo root**; `file:line` citations are from the on-disk files.`A:`/`B:` prefixes mark the tree — unqualified paths in Part A mean tree A, in Part B mean tree B.Tree B paths are under `osu.Game.Rulesets.Mania/` unless stated otherwise.

---
# Part A — bancho (official lazer) mania

## A.1 File map
| role | path (tree A) |
|------|---------------|
| ruleset wiring | `osu.Game.Rulesets.Mania/ManiaRuleset.cs` — health :57, performance :61, score multiplier :310, difficulty :320 |
| **performance calculator** | `osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceCalculator.cs` (80 lines) |
| performance attributes | `osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceAttributes.cs` |
| **difficulty calculator** | `osu.Game.Rulesets.Mania/Difficulty/ManiaDifficultyCalculator.cs` (135 lines) |
| difficulty attributes | `osu.Game.Rulesets.Mania/Difficulty/ManiaDifficultyAttributes.cs` |
| strain skill (the only skill) | `osu.Game.Rulesets.Mania/Difficulty/Skills/Strain.cs` |
| evaluators (per-column / overall strain) | `osu.Game.Rulesets.Mania/Difficulty/Evaluators/{IndividualStrainEvaluator,OverallStrainEvaluator}.cs` |
| difficulty hit object | `osu.Game.Rulesets.Mania/Difficulty/Preprocessing/ManiaDifficultyHitObject.cs` |
| **hit windows** | `osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs` |
| **score multiplier calculator** | `osu.Game.Rulesets.Mania/Scoring/ManiaScoreMultiplierCalculator.cs` + base `osu.Game/Rulesets/Scoring/ScoreMultiplierCalculator.cs` |
| **health processor** | `osu.Game.Rulesets.Mania/Scoring/ManiaHealthProcessor.cs` + base `osu.Game/Rulesets/Scoring/LegacyDrainingHealthProcessor.cs` |
| score processor / legacy score simulator | `osu.Game.Rulesets.Mania/Scoring/ManiaScoreProcessor.cs`, `.../Difficulty/ManiaLegacyScoreSimulator.cs` |
| shared bases | `osu.Game/Rulesets/Difficulty/{DifficultyCalculator.cs,Difficulty/Preprocessing/DifficultyHitObject.cs,Difficulty/Skills/{Skill,StrainSkill,StrainDecaySkill}.cs,Difficulty/Utils/DiffUtils.cs}`, `osu.Game/Utils/ModUtils.cs` |
| golden SR test + map | `osu.Game.Rulesets.Mania.Tests/ManiaDifficultyCalculatorTest.cs`, `.../Resources/Testing/Beatmaps/diffcalc-test.osu` |

## A.2 Star-rating pipeline (exact)
1. `ManiaRuleset.CreateDifficultyCalculator` :320 → `new ManiaDifficultyCalculator(RulesetInfo, beatmap)`; `Version => 20241007` (:32).
2. `double clockRate = ModUtils.CalculateRateWithMods(mods);` (:71) = fold of `IApplicableToRate.ApplyToRate` (`A:osu.Game/Utils/ModUtils.cs:288-297`), where `ModRateAdjust.ApplyToRate` is `rate * SpeedChange.Value` (`A:osu.Game/Rulesets/Mods/ModRateAdjust.cs:26`); DT 1.5 / HT 0.75 defaults.
3. **Ordering is not the default LINQ sort** (:73): `LegacySortHelper<HitObject>.Sort(sortedObjects, Comparer<HitObject>.Create((a, b) => (int)Math.Round(a.StartTime) - (int)Math.Round(b.StartTime)));` → *unstable* depth-limited quicksort/heapsort (`A:.../MathUtils/LegacySortHelper.cs:19-155`) keyed on **rounded** start times, reproducing osu!stable chord order.
4. `for (int i = 1; i < sortedObjects.Length; i++)` (:81) → only `N-1` `DifficultyHitObject`s; object 0 is never processed.
5. Per-object state (`ManiaDifficultyHitObject.cs`): `Column` :19; `ColumnStrainTime = StartTime - PrevInColumn(0)?.StartTime ?? StartTime` :34; `PreviousHitObjects[]` = most recent object per column, with the comment *"intentionally depends on processing order to match live"* (:40-44); `PrevInColumn`/`NextInColumn` are **exclusive of LN tails** (:48-68). The base class supplies clock-adjusted `StartTime`/`EndTime`/`DeltaTime` (`A:.../Preprocessing/DifficultyHitObject.cs:70-74`).
6. One skill only: `new Strain(mods, ((ManiaBeatmap)Beatmap).TotalColumns)` (:94-97).
7. `Strain.cs`: `individual_decay_base = 0.125` (:16), `overall_decay_base = 0.30` (:17), `SkillMultiplier => 1` (:19), `StrainDecayBase => 1` (:20).
```csharp
individualStrains[Column] = applyDecay(individualStrains[Column], ColumnStrainTime, 0.125);   // :37
individualStrains[Column] += IndividualStrainEvaluator.EvaluateDifficultyOf(current);         // :38
highestIndividualStrain = DeltaTime <= 1 ? Math.Max(highestIndividualStrain, individualStrains[Column])
                                         : individualStrains[Column];                          // :42 chord rule
overallStrain = applyDecay(overallStrain, DeltaTime, 0.30);                                    // :44
overallStrain += OverallStrainEvaluator.EvaluateDifficultyOf(current);                         // :45
return highestIndividualStrain + overallStrain - CurrentStrain;                                // :48
```
   `- CurrentStrain` makes the skill keep only the per-section maximum; `CurrentStrain` is read **after** decay and **before** this object's strain is added (`A:.../Difficulty/Skills/StrainDecaySkill.cs:39-42`). `applyDecay(v, dt, b) => v * DiffUtils.Pow(b, dt / 1000)` (:55-56); section start strain = decayed `highestIndividualStrain` (0.125) + decayed `overallStrain` (0.30) (:51-53). Sections: `SectionLength => 400`, `DecayWeight => 0.9` (`StrainSkill.cs:22,27`); `DifficultyValue()` (:121+) = descending-sorted weighted sum of section peaks, weight `×0.9` each step, zero peaks dropped.
8. Evaluators — `IndividualStrainEvaluator.cs:18-34`: `holdFactor = 1.25` if any previous object satisfies `endTime_prev > endTime_cur && startTime_cur > startTime_prev` (strict, `Precision.DefinitelyBigger(..., 1)`), returns `2.0 * holdFactor`. `OverallStrainEvaluator.cs`: `release_threshold = 30` (:14); `closestEndTime = min over prev of |endTime_cur − endTime_prev|` seeded with `|endTime − startTime|` (:23,42); `isOverlapping |= prev.End > start_cur && end_cur > prev.End && start_cur > prev.Start` (:33-35); `holdFactor = 1.25` under the same nesting test (:38-40); `if (isOverlapping) holdAddition = DiffUtils.Logistic(x: closestEndTime, multiplier: 0.27, midpointOffset: release_threshold)` (:55-56); returns `(1 + holdAddition) * holdFactor` (:58). `Logistic(x, midpointOffset, multiplier, maxValue=1) = maxValue / (1 + exp(multiplier*(midpointOffset − x)))` (`A:osu.Game/.../Utils/DiffUtils.cs`).
9. `StarRating = skills.OfType<Strain>().Single().DifficultyValue() * difficulty_multiplier` with `private const double difficulty_multiplier = 0.018;` (:28,50).
10. `MaxCombo = Σ maxComboForObject(o)`: `HoldNote` → `1 + (int)((hold.EndTime - hold.StartTime) / 100)`, else `1` (:52,58-64) — integer division, no rounding.

**Dead code:** `CreateDifficultyAttributes` builds `new ManiaHitWindows(); SetDifficulty(...)` (:45-46) and then **never uses it** — mania SR in tree A has **zero** OD/HR/EZ dependence. `ManiaDifficultyAttributes` adds only `ATTRIB_ID_DIFFICULTY`; fields = `StarRating`, `MaxCombo`, `Mods`.

## A.3 The complete PP formula (tree A)
`A:osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceCalculator.cs` — the whole algorithm is these lines:
```csharp
// :33-39
countPerfect = score.Statistics.GetValueOrDefault(HitResult.Perfect);
countGreat   = score.Statistics.GetValueOrDefault(HitResult.Great);
countGood    = score.Statistics.GetValueOrDefault(HitResult.Good);
countOk      = score.Statistics.GetValueOrDefault(HitResult.Ok);
countMeh     = score.Statistics.GetValueOrDefault(HitResult.Meh);
countMiss    = Math.Max(0, score.Statistics.GetValueOrDefault(HitResult.Miss));
scoreAccuracy = Math.Clamp(calculateCustomAccuracy(), 0, 1);
// :41-49
double multiplier = 1.0;
if (score.Mods.Any(m => m is ModNoFail)) multiplier *= 0.75;
if (score.Mods.Any(m => m is ModEasy))   multiplier *= 0.5;
double difficultyValue = computeDifficultyValue(maniaAttributes);
double totalValue = difficultyValue * multiplier;
// :58-65
double difficultyValue = 8.0 * Math.Pow(Math.Max(attributes.StarRating - 0.15, 0.05), 2.2) // Star rating to pp curve
                             * Math.Max(0, 5 * scoreAccuracy - 4) // From 80% accuracy, 1/20th of total pp is awarded per additional 1% accuracy
                             * (1 + 0.1 * Math.Min(1, totalHits / 1500)); // Length bonus, capped at 1500 notes
// :67
private double totalHits => countPerfect + countOk + countGreat + countGood + countMeh + countMiss;
// :72-78
if (totalHits == 0) return 0;                                             // :74-75
return (countPerfect * 320 + countGreat * 300 + countGood * 200 + countOk * 100 + countMeh * 50) / (totalHits * 320);
```

| symbol | value | line |
|---|---|---|
| star base / offset / floor | `8.0`, `StarRating − 0.15`, floor `0.05` | :60 |
| star exponent | `2.2` | :60 |
| accuracy term | `max(0, 5·acc − 4)` → 0 below 80 % acc, 1.0 at 100 % | :61 |
| custom-acc weights | P=320, Great=300, Good=200, Ok=100, Meh=50, Miss=0 | :77 |
| custom-acc denominator | `totalHits * 320`; `totalHits = P+Ok+Great+Good+Meh+Miss` (Ok included; miss clamped ≥ 0) | :67,77 |
| accuracy clamp | `Math.Clamp(…, 0, 1)` | :39 |
| length/density term | `1 + 0.1 * min(1, totalHits / 1500)` → cap **1.10** at ≥ 1500 hits | :62 |
| NF / EZ | `×0.75` / `×0.5` | :43-46 |
| final | `Total = Difficulty * multiplier`; **no clamp, no floor, no pp cap** | :49,54 |

`Total` is the PP; `Difficulty` (`ManiaPerformanceAttributes.cs:12-20`) is the **pre-NF/EZ** value shown in thebreakdown. `totalHits / 1500` is **integer** division. OD, HP, columns, LN count, MaxCombo and every mod otherthan NF/EZ are **absent** from mania pp. `scoreAccuracy` ≠ the client-displayed accuracy.

## A.4 Hit windows (`ManiaHitWindows.cs`)
```csharp
// :12-17 ranges (od0 / od5 / od10)
PERFECT_WINDOW_RANGE = new DifficultyRange(22.4D, 19.4D, 13.9D);
great = (64, 49, 34);  good = (97, 82, 67);  ok = (127, 112, 97);  meh = (151, 136, 121);  miss = (188, 173, 158);
private double totalMultiplier => speedMultiplier / difficultyMultiplier;                        // :58
// :129-150 classic branch (ClassicModActive && !ScoreV2Active), non-convert
double invertedOd = Math.Clamp(10 - overallDifficulty, 0, 10);
perfect = Math.Floor(16 * totalMultiplier) + 0.5;                                                // :144
great   = Math.Floor((34 + 3 * invertedOd) * totalMultiplier) + 0.5;   // good/ok/meh/miss: 67/97/121/158 + 3*invertedOd
// :131-138 classic CONVERT branch: (Math.Round(od) > 4 ? 34 : 47) great, (… ? 67 : 77) good, then 97/121/158
// :154-159 default branch: Math.Floor(IBeatmapDifficultyInfo.DifficultyRange(od, range) * totalMultiplier) + 0.5
```
`DifficultyRange(d,min,mid,max)` is two-piece linear (`A:osu.Game/Beatmaps/IBeatmapDifficultyInfo.cs:57-65`):`d>5 → mid+(max−mid)(d−5)/5`; `d<5 → mid+(mid−min)(d−5)/5`; `d==5 → mid`.Setters: `SpeedMultiplier` via `IManiaRateAdjustmentMod` (`Mods/IManiaRateAdjustmentMod.cs:19-36`);`DifficultyMultiplier = 1.4` for HR (`Mods/ManiaModHardRock.cs:15,22-27`), `1/1.4` for EZ(`Mods/ManiaModEasy.cs:16,23-28`); `ClassicModActive` (`Mods/ManiaModClassic.cs`); `ScoreV2Active`(`Mods/ManiaModScoreV2.cs`); `IsConvert` from ruleset identity. `Math.Round` here is **banker's rounding** (see C).These are *gameplay* windows — they never reach mania SR or pp in tree A.

## A.5 Score multiplier calculator (score only, never PP)
`ManiaScoreMultiplierCalculator.cs`: EZ `0.5` :19; NF `0.5` :20; HT/DC via `rateAdjustMultiplier(SpeedChange)`:21-22,:88-100; NoRelease `0.9` :23; DifficultyAdjust `0.5` :47; Classic `classicMultiplier(score)` → `0.96` if`score.TotalScoreVersion < 30000017` else `1` (:48,:146-152); ConstantSpeed `0.9` :50; HoldOff `0.9` :51; key mods`keyModMultiplier(score)` → `0.9` (legacy `1` for clients before `2025.718`) :52-61,:102-144; WindUp/WindDown/AdaptiveSpeed `0.5` :74-77. Combination logic in `A:osu.Game/Rulesets/Scoring/ScoreMultiplierCalculator.cs:CalculateFor`.**It never feeds pp** — pp applies its own NF/EZ multipliers (A.3), i.e. score multiplier ≠ pp multiplier.

## A.6 Health processor (`ManiaHealthProcessor.cs`)
Extends `LegacyDrainingHealthProcessor`; `ComputeDrainRate()` calls `base.ComputeDrainRate()` **only** to obtain`HpMultiplierNormal`, then `return 0;` (:18-25) → **mania has no passive drain**.`GetHealthIncreaseFor(hitObject, result)` (:31-68): `Miss` → `-(DR+1)*0.00375` on `HeadNote`/`TailNote`, else`-(DR+1)*0.0075`; `Meh` → `-(DR+1)*0.0016`; `Ok` → `0`; `Good` → `0.004 − DR*0.0004`; `Great` → `0.005 − DR*0.0005`;`Perfect` → `0.0055 − DR*0.0005`; positives are `× HpMultiplierNormal`. `DR` = `Beatmap.Difficulty.DrainRate`.Base iteration (drop test `0.00025`; `lowestHpEver/lowestHpEnd/hpRecoveryAvailable` from`DifficultyRange(DR, 0.975,0.8,0.3 / 0.99,0.9,0.4 / 0.04,0.02,0)`) in`A:osu.Game/Rulesets/Scoring/LegacyDrainingHealthProcessor.cs`. Relevant only to NF failure-risk modelling, not pp.

## A.7 Mods that matter (tree A)
| mod | effect | location |
|---|---|---|
| `ManiaModNoFail` | pp `×0.75` | `ManiaPerformanceCalculator.cs:43-44` |
| `ManiaModEasy` | pp `×0.5`; hit windows `×1.4`; extra life | :45-46; `Mods/ManiaModEasy.cs:16` |
| `ManiaModDoubleTime`/`Nightcore` (1.5), `HalfTime`/`Daycore` (0.75) | clock rate → `/clockRate` on all times | `Mods/ManiaMod{DoubleTime,HalfTime}.cs`; `ModUtils.cs:288-297` |
| `ManiaModHardRock` | hit windows `÷1.4` only (**no OD change**); `Ranked => false` | `Mods/ManiaModHardRock.cs:13-15` |
| `ManiaModClassic` | switches windows to the stable-legacy branch | `Mods/ManiaModClassic.cs` |
| `ManiaModScoreV2` | forces the non-classic branch | `Mods/ManiaModScoreV2.cs` |
| `ManiaModDifficultyAdjust` | OD (0..10, extended −15..15) → windows | `Mods/ManiaModDifficultyAdjust.cs` |
| key mods `Key1..10`, `DualStages` | column count, converts only (listed in `DifficultyAdjustmentMods`) | `ManiaDifficultyCalculator.cs:99-133` |
| Hidden / Cover / FadeIn / Flashlight / Invert / Random / Mirror / Muted | not read by the mania difficulty or performance calculator | — |
| NoRelease / ConstantSpeed / HoldOff | score multiplier only | A.5 |

## A.8 Inputs the bancho formula needs
`CreatePerformanceAttributes(ScoreInfo score, DifficultyAttributes attributes)` (:29):`attributes` cast to `ManiaDifficultyAttributes` → **only `StarRating`** is read (:60) (`MaxCombo`/`Mods` unused);`score.Statistics` → `HitResult.{Perfect,Great,Good,Ok,Meh,Miss}` counts (:33-38); `score.Mods` → presence of`ModNoFail`/`ModEasy` (:43-46). Nothing else: no OD, HP, columns, BPM or object count.For SR: the parsed beatmap (objects with `Column` and hold `EndTime`) plus mods (rate; column count for converts).

## A.9 Golden verification anchors (tree A)
`A:osu.Game.Rulesets.Mania.Tests/ManiaDifficultyCalculatorTest.cs:17,21`
```
diffcalc-test.osu   NoMod -> StarRating = 2.3493769750220914, MaxCombo = 242
diffcalc-test.osu   DT    -> StarRating = 2.797245912537965,  MaxCombo = 242
```
Harness tolerance `CHECK_PRECISION = 0.00001` (`A:osu.Game/Tests/Beatmaps/DifficultyCalculatorTest.cs:30`).Map = `.../Resources/Testing/Beatmaps/diffcalc-test.osu` (4K, OD 7, `Mode: 3`); the harness decodes with`LegacyBeatmapDecoder` and `ApplyOffsets = false` (no audio-lead-in offset).**NOT FOUND:** any mania *performance* (pp) test with expected pp — grepped`ManiaPerformanceCalculator|ManiaPerformanceAttributes` over the whole tree; only the class files and`ManiaRuleset.cs:61` match.

---
# Part B — sunny (community Star-Rating-Rebirth, author's C# port)

## B.1 File map and public entry points (tree B)
| role | path |
|---|---|
| **sunny skill (entry to SR)** | `osu.Game.Rulesets.Mania/Difficulty/Skills/SunnySkill.cs` |
| **sunny core algorithm** | `osu.Game.Rulesets.Mania/Difficulty/Calculators/MACalculator.cs` (1326 lines) |
| difficulty calculator | `osu.Game.Rulesets.Mania/Difficulty/ManiaDifficultyCalculator.cs` |
| difficulty attributes (metric carrier) | `osu.Game.Rulesets.Mania/Difficulty/ManiaDifficultyAttributes.cs` |
| **sunny PP** | `osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceCalculator.cs` |
| performance attributes | `osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceAttributes.cs` |
| factories | `osu.Game.Rulesets.Mania/ManiaRuleset.cs:59` (performance), `:315` (difficulty) |

```csharp
// B:.../Difficulty/Skills/SunnySkill.cs:17,28,50,63,78,83
public class SunnySkill : Skill
public SunnySkill(Mod[] mods, int totalColumns, double od, int objectCount, double greatHitWindow)
public override void Process(DifficultyHitObject current)   // :50  fills noteSeq + noteSeqByColumn
public override double DifficultyValue()                    // :63  -> SR (also sets spikiness/switches)
public double VarietyValue()                                // :78
public double AccScalarValue()                              // :83  -> 0.5*spikiness + 0.5*switches
// B:.../Difficulty/Calculators/MACalculator.cs:40,51,56,1160,1223
public struct SRParams { public double SR; public double Spikiness; public double Switches; }
public static class MACalculator
public static SRParams Calculate(List<Note> noteSeq, List<List<Note>> noteSeqByColumn, int keyCount, double x, bool ContainsCL)
public static double Variety(List<Note> noteSeq, List<List<Note>> noteSeqByColumn)
public static double Switches(List<Note> noteSeq, List<Note> tailSeq, double[] allCorners, double[] KsArr, double[] weights)
// B:.../Difficulty/ManiaPerformanceCalculator.cs:14,29
public class ManiaPerformanceCalculator : PerformanceCalculator
protected override PerformanceAttributes CreatePerformanceAttributes(ScoreInfo score, DifficultyAttributes attributes)
```
There is **no** separate sunny ruleset/calculator type: sunny is grafted into the normal `ManiaDifficultyCalculator`by replacing `Strain` with `SunnySkill` (:94-97) and overriding `CreateDifficultyAttributes` (:39-61).Case-insensitive grep for `sunny` over tree B matches only `SunnySkill.cs` and `ManiaDifficultyCalculator.cs`.

## B.2 The `x` parameter (OD / hit window)
`B:.../Difficulty/ManiaDifficultyCalculator.cs:135-159` → `getHitWindow300(mods, clockRate)`:
```csharp
if (isForCurrentRuleset)
{
    double anti_od = Math.Min(10.0, Math.Max(0, 10.0 - originalOverallDifficulty));  // :139
    return applyModAdjustments(34 + 3 * anti_od, mods, clockRate);                   // :140
}
if (Math.Round(originalOverallDifficulty) > 4) return applyModAdjustments(34, mods, clockRate); // :143-144
return applyModAdjustments(47, mods, clockRate);                                                 // :146
static double applyModAdjustments(double value, Mod[] mods, double clockRate)  // :148-159
{
    value *= clockRate;
    value += 1e-6;                                   // to make sure rounding is correct
    if (mods.Any(m => m is ManiaModHardRock))  value /= 1.4;
    else if (mods.Any(m => m is ManiaModEasy)) value *= 1.4;
    return ((int)(value) + 0.5) / clockRate;
}
```
`originalOverallDifficulty` is captured **before** mods (:36). Then (`SunnySkill.cs:68-69`):
```csharp
double x = 0.3 * Math.Pow(greatHitWindow / 500.0, 0.5);
x = Math.Min(x, 0.6 * (x - 0.09) + 0.09);
```
The second line equals `min(x, 0.6x + 0.036)`, so it binds iff `x > 0.09` (≈ `greatHitWindow > 45 ms`): an uppercompression, not a clamp. `x` is used as "harder ⇒ smaller" — `Math.Pow(x, 0.25)` in Jbar, `1/x` in Pbar/Rbar,`(4/x − λ3)` in the Pbar spike, `0.75·x` in `fastCross`.**The `od` constructor parameter is dead:** `private double od;` is assigned at :21,31 and never read(`rg "\bod\b"` on the file → only those two lines). All OD influence flows through `greatHitWindow`.

## B.3 `MACalculator.Calculate` — the difficulty components
```csharp
const double lambda_n = 5;   const double lambda_1 = 0.11;  const double lambda_3 = 24.0;   // :59-68
const double lambda2  = 6.0; const double lambda_4 = 0.8;   const double w0 = 0.4;
const double w1 = 2.7;       const double p1 = 1.5;         const double w2 = 0.27;  const double p0 = 1.0;
```
Data model: `class Note { int Column; int Head; int Tail; int ColumnIndex; }` (:7-21) — `Tail = -1` marks rice;`class CornerData { Time, Jbar, Xbar, Pbar, Abar, Rbar, C, Ks, D, Weight }` (:26-38).
1. **Sort + index** (:71-96): `noteSeq.Sort((a,b) => Head then Column)`; rebuild per-column dicts; write back `note.ColumnIndex` = position in its column list.
2. **LN partition** (:99-112): `LNSeq = noteSeq.Where(n => n.Tail >= 0)`; `tailSeq = LNSeq.OrderBy(n => n.Tail)`.
3. **Time grid** (:114-161): `T = max(maxHead, maxTail) + 1`. `baseCorners` = `{Head} ∪ {Tail} ∪ {s+501, s−499, s+1} ∪ {0, T}` filtered to `[0,T]`, sorted (the `+501/−499` asymmetry encodes `[s−499, s+501)`). `ACorners` = `{Head} ∪ {Tail} ∪ {s±1000} ∪ {0,T}` filtered, sorted. `allCorners` = their union, sorted.
4. **`KU` (key usage)** (:166-207): `key_usage[k][i] = true` for base corners inside `[max(Head−150,0), (Tail<0 ? Head+150 : min(Tail+150, T−1)))`; `KU_s_cols[i]` = sorted active columns.
5. **`key_usage_400`** (:209-247): `+= 3.75 + Math.Min(activeEnd − activeStart, 1500) / 150` inside the body, plus parabolic shoulders `3.75 − 3.75/Math.Pow(400,2) * Math.Pow(d, 2)` over ±400 ms.
6. **`anchor`** (:249-285): per corner, sort `key_usage_400` descending and drop zeros; for ≥ 2 non-zero values `anchor = Σ_c v_c·(1 − 4·Math.Pow(0.5 − v_{c+1}/v_c, 2)) / Σ_c v_c`, else `0`; then `anchor[i] = 1 + Math.Min(anchor[i] - 0.18, 5 * Math.Pow(anchor[i] - 0.22, 3))` — a hard-coded `1 +` floor.
7. **`Jbar`** (per-column jack strain, :289-364): `jackNerfer(δ) = 1 - 7e-5 * Math.Pow(0.15 + Math.Abs(δ - 0.08), -4)` (:289-292). Per column and adjacent note pair: `delta = 0.001*(end − start)`, `val = (1.0/delta) * (1.0/(delta + lambda_1 * Math.Pow(x, 0.25)))`, `J_val = val * jackNerfer(delta)` (:321-323), written as a step function over base corners in `[start, end)`. Per-column smoothing `SmoothOnCorners(baseCorners, J_ks[k], 500, 0.001, "sum")` (:344). Cross-column power mean (:348-361): `Jbar_base[j] = Math.Pow( Σ_k Math.Pow(max(Jbar_ks[k][j],0), 5)·(1/δ_k) / Math.Max(1e-9, Σ_k 1/δ_k), 1/5 )` with `delta_ks` **initialised to `1e9`** (:306). Linear interpolation to `allCorners` (:364).
8. **`Xbar`** (cross-column transition strain, :369-491): `crossMatrix` is indexed by key count (rows for 1..10 keys); for `keyCount >= crossMatrix.Count` the fallback coefficient is a flat `0.4` (:444,472,480-481). For `k in 0..keyCount` **inclusive** (`keyCount+1` virtual slots) build a step function over the merged adjacent-column note sequence (`k==0` → column 0; `k==keyCount` → last column; else `MergeSorted(col k−1, col k)`, :401-413): `delta = 0.001*(end − start)`, `val = 0.16 * Math.Pow(Math.Max(x, delta), -2)` (:423). `leftKeyNotPresent = !KU_s_cols[a].Contains(k−1) && !KU_s_cols[b].Contains(k−1)`, `keyNotPresent` likewise for `k`; if either → `val *= (1 - crossVal)` (:446-450). Alongside, `fastCross[k][p] = Math.Max(0, 0.4 * Math.Pow(Math.Max(Math.Max(delta, 0.06), 0.75 * x), -2) - 80)` (:457). Combine (:465-487): `X_base = Σ_{k=0..keyCount} X_ks[k]·cross[k] + Σ_{k=0..keyCount−1} Math.Sqrt(fastCross[k]·cross[k] · fastCross[k+1]·cross[k+1])`. Smooth 500 ms sum + interpolate (:490-491).
9. **`Pbar`** (density/pattern strain with LN bodies, :497-603): `LN_bodies` gets `+1.3` on `[min(h+60,t), min(h+120,t))` and `+1.0` on `[min(h+120,t), t)` (:504-514), then `LN_bodies[i] = Math.Min(LN_bodies[i], 2.5 + 0.5 * LN_bodies[i])` (:517-520); `cumsum_LN` frames `LN_sum(a,b) = cumsum_LN[b] − cumsum_LN[a]` (:523-531); `streamBooster(δ)`: `val = 7.5/δ; if (val > 160 && val < 360) return 1 + 1.7e-7*(val−160)*Math.Pow(val−360, 2); return 1.0;` (:534-540). Per adjacent `noteSeq` pair — `delta = 0.001*(h_r−h_l)`, `v = 1 + lambda2*0.001*LN_sum(h_l,h_r)`, `bVal = streamBooster(delta)`, then (:577-586):
```csharp
if (delta < 2*x/3) inc = (1/delta)*Math.Pow(0.08*(1/x)*(1 - lambda_3*(1/x)*Math.Pow(delta - x/2, 2)), 0.25)*Math.Max(bVal, v);
else               inc = (1/delta)*Math.Pow(0.08*(1/x)*(1 - lambda_3*(1/x)*Math.Pow(x/6, 2)), 0.25)*Math.Max(bVal, v);
```
   Dirac case `delta_time < 1e-9` (:557-570): `P_step[idx] += 1000 * Math.Pow(0.02 * (4/x - lambda_3), 0.25)` at the single base corner equal to `h_l`; if no corner matches within `1e-9` the spike is silently **dropped**. Accumulation `P_step[p] += Math.Min(inc * anchor[p], Math.Max(inc, inc * 2 - 10))` (:595). Then smooth + interp (:602-603).
10. **`Abar`** (chord/alignment, :611-662): `dks[k0][i] = Math.Abs(δ_{k0} − δ_{k1}) + 0.4 * Math.Max(0, Math.Max(δ_{k0}, δ_{k1}) − 0.11)` over adjacent *active* key pairs (:624-625). On the A-grid, starting from `A_step[i] = 1.0` (:630-632), for every adjacent active pair: `if (d < 0.02) A *= Math.Min(0.75 + 0.5*Math.Max(δ_{k0},δ_{k1}), 1);` `else if (d < 0.07) A *= Math.Min(0.65 + 5*d + 0.5*Math.Max(δ_{k0},δ_{k1}), 1);` (:652-655). Smoothed on the **A-grid** with window 250 / scale 1.0 / `"avg"` (:661) — the only `"avg"` smoothing in the file.
11. **`Rbar`** (LN release, :668-747): per LN in `tailSeq`, `currentI = 0.001 * Math.Abs(Tail - Head - 80.0) / x` (:692); `nextI = 0.001 * Math.Abs(nextNote.Head - Tail - 80.0) / x` where `nextNote` is the next note **in the same column** (not necessarily an LN) (:686-700); `I = 2 / (2 + Math.Exp(-5*(currentI - 0.75)) + Math.Exp(-5*(nextI - 0.75)))`, dropping the second exponential when there is no next note (:696,702). Then per adjacent tail pair, `delta_r = 0.001*(Tail_{i+1} − Tail_i)`, `I_arr[j] = 1 + I_list[i]`, `R_base[j] = 0.08 * Math.Pow(delta_r, -1.0/2.0) * (1/x) * (1 + lambda_4 * (I_list[i] + I_list[i+1]))` (:739-741). The walk uses the monotone `previous_idx_start` pointer (:705,717-725), so out-of-order tails are skipped.
12. **`C` and `Ks`** (:752-798): `noteHitTimes = heads`; `noteHitTimesV2 = heads ∪ LN tails`; `C_step[i]` = count of times in `[s−500, s+500)` via `LowerBound`; `Ks_step[i] = Math.Max(cntActive, 1)`; both expanded by `StepInterp` (**zero-order hold**, not linear).
13. **`S`, `T`, `D`** (:801-822):
```
term1 = Math.Pow(Math.Pow(A, 3.0/Ks) * Math.Min(J, 8 + 0.85*J), 1.5)
term2 = Math.Pow(Math.Pow(A, 2.0/3.0) * (0.8*P + R * 35.0/(C + 8)), 1.5)
S = Math.Pow(w0*term1 + (1-w0)*term2, 2.0/3.0)
T = (Math.Pow(A, 3.0/Ks) * X) / (X + S + 1)
D = w1 * Math.Pow(S, 0.5) * Math.Pow(T, p1) + S * w2
```

## B.4 Aggregation and the star rating
```csharp
gaps[0] = (allCorners[1] - allCorners[0]) / 2.0;                 // :830
gaps[N-1] = (allCorners[N-1] - allCorners[N-2]) / 2.0;           // :831
gaps[i] = (allCorners[i+1] - allCorners[i-1]) / 2.0;             // :833
if (ContainsCL) effectiveWeights[i] = C_arr[i] * gaps[i];        // :837-839
else            effectiveWeights[i] = C_arrV2[i] * gaps[i];      // :840-842
double[] targetPercentiles = new double[] { 0.945, 0.935, 0.925, 0.915, 0.845, 0.835, 0.825, 0.815 };  // :872
int idx = Array.FindIndex(normCumWeights, cw => cw >= tp);       // first reaching tp, else last index :876-879
percentile93 = mean(D at indices[0..3]);   percentile83 = mean(D at indices[4..7]);   // :884-891
// fewer than 8 indices -> percentile93 = percentile83 = sortedList.Average(cd => cd.D)      :895-896
weightedMean = Math.Pow(numWeighted / denWeighted, 1.0 / lambda_n);                         // :898-905
double SR = (0.88 * percentile93) * 0.25 + (0.94 * percentile83) * 0.2 + weightedMean * 0.55;  // :907
SR = Math.Pow(SR, p0) / Math.Pow(8, p0) * 8;                                                   // :908 (no-op, p0 = 1)
double totalNotes = noteSeq.Count + 0.5 * LNSeq.Sum(ln => Math.Min(ln.Tail - ln.Head, 1000) / 200.0);  // :911
SR *= totalNotes / (totalNotes + 60);                                                          // :912
SR = rescaleHigh(SR);                                                                          // :914
SR *= 0.975;                                                                                   // :915
// rescaleHigh (:941-947): if (sr <= 9) return sr; return 9 + (sr - 9) * (1.0 / 1.2);
```
So: eight weight-fraction targets collapse into two 4-element means (≈ 93 % and ≈ 83 % of *weight*), plus a`p = 5` weighted power-mean; then a length normalisation using a **second, different** note count (heads + half ofcapped LN durations), a high-end compression above 9★, and a flat `×0.975`.⚠ **`ContainsCL` selects the head-only counter `C_arr`; the non-CL path uses `C_arrV2` (heads + LN tails).**`ContainsCL = mods.Any(m => m is ModClassic)` (`SunnySkill.cs:71`); tree B's `ManiaModClassic` is an emptysubclass of `ModClassic` (acronym `CL`, `B:osu.Game/Rulesets/Mods/ModClassic.cs`).

## B.5 The pp metrics: variety, accScalar, spikiness, switches, totalNotes
`B:.../Difficulty/ManiaDifficultyCalculator.cs:47-58`:
```csharp
StarRating     = skills[0].DifficultyValue(),
Variety        = ((SunnySkill)skills[0]).VarietyValue(),
AccScalar      = ((SunnySkill)skills[0]).AccScalarValue(),
TotalNotes     = beatmap.HitObjects.Count,
GreatHitWindow = getHitWindow300(mods, clockRate),
```
⚠ **Order dependence.** C# evaluates object-initializer assignments in source order, so `DifficultyValue()` runsfirst: it fills `spikiness`/`switches` (`SunnySkill.cs:72-73`) and **sorts `noteSeq` in place** inside`MACalculator.Calculate` (:71-75), while `Variety()` assumes heads are already in `(Head, Column)` order.

| metric | where | exactly how |
|---|---|---|
| `spikiness` | `MACalculator.cs:917-927` | `variance_sum_top = Σ (Math.Pow(D_sorted[i], 8) − Math.Pow(weightedMean, 8))² · w_i`; `weighted_variance = Math.Pow(variance_sum_top / denWeighted, 1.0/8.0)`; `spikiness = Math.Sqrt(weighted_variance) / weightedMean`. `denWeighted` is snapshotted at :918 **after** the weightedMean loop. `D_sorted` ascending, with `sortedList[i].Weight` keeping weights aligned. |
| `switches` | `MACalculator.cs:1223-1322`, called at :928 with `weights = D_all` | heads: `idx = LowerBound(allCorners, head)`, last element dropped via `Take(count−1)`; moving average of head gaps over the **clipped** index window `[Math.Max(0,i−50), Math.Min(i+50, n−1)]`; `signatureHead += Math.Sqrt((gap/avg/numGaps)·weight) * Math.Pow(Ks, 0.25)`; `refSignatureHead = Math.Sqrt(Σ (gap/avg)·weight)`. Identical tail block, guarded by `tails.Count > 0 && tails[last] > tails[0] && tailGaps.Count > 0`. `switches = numerator/denominator` with `numerator = signatureHead*numHeadGaps + signatureTail*tailGaps.Count` (same shape for the denominator). **Returns `switches / 2.0 + 0.5`** (:1322). |
| `AccScalar` | `SunnySkill.cs:83-86` | `0.5*spikiness + 0.5*switches`. If `DifficultyValue()` short-circuited (`noteSeq.Count <= 0`, :65-66) both stay `0` → AccScalar `0`. |
| `Variety` | `MACalculator.Variety` :1160-1201 | `tailSeq = noteSeq.OrderBy(n => n.Tail)` — **includes rice** (`Tail = −1` sorts first); `headGaps` = consecutive head diffs over the whole sequence; `tailGaps` = consecutive tail diffs over that ordering; `colVariety` uses per-column head gaps with `logIterations = 2`. Returns `0.5*headVariety + 0.11*tailVariety + 0.45*colVariety` (weights sum to **1.06**). `RaoQuadraticEntropyLog(values, logIterations)`: `Q = ΣΣ p_i p_j d(v_i,v_j)`, `d = \|x−y\|` with `Math.Log(1+·)` applied `logIterations` times (:1093-1156). |
| `TotalNotes` | `ManiaDifficultyCalculator.cs:52` | `beatmap.HitObjects.Count` — **top-level objects** (one LN = 1), i.e. exactly `1` more than `noteSeq.Count`. |

## B.6 Held notes (LN) and the "rice" concept
- **Rice** is implicit: `Note.Tail = -1` (:11-20). `SunnySkill.Process` (:54) does `int endTime = currObj.EndTime == currObj.StartTime ? -1 : (int)currObj.EndTime;` — the rice test is `EndTime == StartTime` and both times are truncated to `int`.
- LN participation: `LNSeq`/`tailSeq` (:99-100); `LN_bodies`/`cumsum_LN` feeding `Pbar` (:497-531); `Rbar`/`I_list` (:668-747); `C_arrV2` (:752-784) and the non-CL weighting (:840-842).
- LN length is capped at **1000 ms** in the SR length normalisation (:911) but **not** capped in the 1500 ms `key_usage_400` body term (:239).
- There is no separate LN/rice skill — LN effects fold into `Pbar`/`Rbar`/`C` and into the endpoint logic of `A`/`X`, and `DifficultyValue()` returns one scalar. The project's "rice SR" must therefore come from re-running the algorithm on a tail-stripped map, not from a code path in this port.

## B.7 Sunny PP formula (tree B)
`B:osu.Game.Rulesets.Mania/Difficulty/ManiaPerformanceCalculator.cs` (120 lines):
```csharp
countPerfect = score.Statistics.GetValueOrDefault(HitResult.Perfect);   // :33 (Great/Good/Ok/Meh likewise)
countMiss    = score.Statistics.GetValueOrDefault(HitResult.Miss);      // :38  NOTE: no Math.Max(0, …)
scoreAccuracy = calculateCustomAccuracy();                              // :39  NOTE: no Math.Clamp(…, 0, 1)
double multiplier = 1.0;                                                // :41
if (score.Mods.Any(m => m is ModNoFail)) multiplier *= 0.75;            // :43-44
if (score.Mods.Any(m => m is ModEasy))   multiplier *= 0.90;            // :45-46
double difficultyValue   = computeDifficultyValue(maniaAttributes);                       // :48
double varietyMultiplier = this.varietyMultiplier(maniaAttributes.Variety);               // :49
double accMultiplier     = this.accMultiplier(scoreAccuracy, maniaAttributes.AccScalar);  // :50
double lengthMultiplier  = this.lengthMultiplier(maniaAttributes.TotalNotes, attributes.StarRating); // :51
double totalValue = difficultyValue * multiplier * varietyMultiplier * accMultiplier * lengthMultiplier; // :52
double proportion = calculatePerformanceProportion(scoreAccuracy);                        // :67
double difficultyValue = 9.8 * Math.Pow(Math.Max(attributes.StarRating - 0.15, 0.05), 2.2) * proportion; // :69-70
return (countPerfect*305 + countGreat*300 + countGood*200 + countOk*100 + countMeh*50) / (totalHits * 305); // :85
private double totalHits => countPerfect + countOk + countGreat + countGood + countMeh + countMiss;         // :75
if (acc > 0.80) return 4.5 * (acc-0.8) / Math.Pow(100*(1-acc)+Math.Pow(0.9, 20), 0.05);  return 0;         // :91-94
double floor = 0.945; double cap = 1.055; double L = cap - floor; double v0 = 3.25; double k = 3;          // :99-103
double sigmoidVariety = floor + L / (1 + Math.Exp(-k * (variety - v0)));                                   // :105
double sigmoid_scaler = 0.87 + 0.26 / (1.0 + Math.Exp(-20 * (acc_scalar - 1)));                            // :111
return sigmoid_scaler * (2 * Math.Pow(acc, 20) - 1) + 2 - 2 * Math.Pow(acc, 20);                           // :112
return 1.1 / (1.0 + Math.Sqrt(starRating / (2 * totalNotes)));                                            // :117
```

| symbol | value | line |
|---|---|---|
| star base / offset / floor / exponent | `9.8`, `StarRating − 0.15`, floor `0.05`, `2.2` | :69 |
| acc → proportion | `4.5·(acc−0.8) / (100·(1−acc) + 0.9^20)^0.05`, `0` when `acc ≤ 0.8` | :91-94 |
| `Math.Pow(0.9, 20)` | `0.12157665459056935` | :92 |
| custom-acc weights | P=305, Great=300, Good=200, Ok=100, Meh=50; denominator `totalHits*305` | :85 |
| NF / EZ | `×0.75` / `×0.90` (EZ differs from lazer's `0.5`) | :43-46 |
| variety sigmoid | floor `0.945`, cap `1.055`, `v0 = 3.25`, `k = 3` | :99-105 |
| acc multiplier | `sigmoid_scaler = 0.87 + 0.26/(1+exp(−20(accScalar−1)))`, blended over `acc^20` | :111-112 |
| length | `1.1 / (1 + Math.Sqrt(StarRating / (2·TotalNotes)))` | :117 |
| final | `Total = difficultyValue · NF/EZ · variety · acc · length`; **no clamp** | :52 |
| emitted fields | `Difficulty`, `VarietyMultiplier`, `AccMultiplier`, `LengthMultiplier`, `Total` | :54-61; `ManiaPerformanceAttributes.cs:12-22` |

## B.8 Modifiers (tree B)
| mod | effect | location |
|---|---|---|
| `ManiaModNoFail` | pp `×0.75` | `ManiaPerformanceCalculator.cs:43-44` |
| `ManiaModEasy` | pp `×0.90`; hit window `×1.4` **before** the integer truncation | :45-46; `ManiaDifficultyCalculator.cs:155-156` |
| `ManiaModHardRock` | hit window `÷1.4`; `Ranked => false`; `ScoreMultiplier => 1`; **no OD change** | `Mods/ManiaModHardRock.cs`; `ManiaDifficultyCalculator.cs:153-154` |
| DT / NC / HT / DC | **only** through `greatHitWindow`: `value *= clockRate` before truncation, then `((int)value + 0.5)/clockRate` → returned GREAT window ≈ `(floor(w·clockRate)+0.5)/clockRate` (chart time, matching osu!stable). `clockRate` does **not** rescale note times — tree B's `ManiaDifficultyHitObject` is an empty 20-line subclass | `ManiaDifficultyCalculator.cs:150,158`; `B:.../Preprocessing/ManiaDifficultyHitObject.cs` |
| `ManiaModClassic` (CL) | switches `effectiveWeights` to the head-only `C_arr` | `SunnySkill.cs:71`; `MACalculator.cs:837-842` |
| DA / ScoreV2 / key mods | no effect on sunny SR or pp (no `ManiaScoreMultiplierCalculator`, no `ManiaModScoreV2`, `ManiaModDifficultyAdjust` is an empty subclass) | — |

**Effective-OD transform (author port only, SR path only):** `anti_od = clamp(10 − OD_original, 0, 10)` for nativemaps → `34 + 3·anti_od`; converts → `34` if `Math.Round(OD) > 4` else `47` (`ManiaDifficultyCalculator.cs:139-146`);then `((int)(value·clockRate + 1e-6 [±1.4 mod scaling]) + 0.5) / clockRate`. This is **not** lazer's`ManiaHitWindows`: tree B's version is a plain multiplier over the base ranges(`B:osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs`, ctor `multiplier`, `GetRanges()` scaling`Min/Average/Max`; base ranges at `B:osu.Game/Rulesets/Scoring/HitWindows.cs:18-26`).

---
# Part C — porting notes

## C.1 Rust porting hazards
**Rounding / numeric**
1. **`Math.Round` is banker's rounding (ToEven); Rust `f64::round()` rounds half away from zero.** Used in tree A `ManiaHitWindows.cs:134-135` and tree B `ManiaDifficultyCalculator.cs:143`. Only OD = 4.5 differs, and there it flips the whole window tier (34 vs 47). Use `round_ties_even()`.
2. **Truncating casts vs `floor`.** `(int)EndTime`/`(int)StartTime` (`SunnySkill.cs:54,56`), `(int)(value)` (`ManiaDifficultyCalculator.cs:158`), `(int)Math.Round(a.StartTime)` (:73). Rust `as i64` truncates toward zero like C#, but `floor()` does not — and times can be negative after offsets.
3. **Integer division.** `totalHits / 1500` (`ManiaPerformanceCalculator.cs:62`) and `(hold.EndTime - hold.StartTime) / 100` (`ManiaDifficultyCalculator.cs:61`) are integer ops; porting them as float silently drops the truncation.
4. **Float association order.** Copy parenthesisation literally: `0.6 * Math.Pow(0.5 - (v1 / v0), 2)` (`MACalculator.cs:267`); `(0.88 * percentile93) * 0.25 + (0.94 * percentile83) * 0.2 + weightedMean * 0.55` (:907); `4.5 * (acc-0.8) / Math.Pow(...)` (`ManiaPerformanceCalculator.cs:92` — left-associative: `(4.5*(acc−0.8))/pow`).
5. **`1.0/8.0`, `2.0/3.0`, `3.0/Ks`** — keep the same literal expressions; the tree-A harness tolerance is `1e-5` (`DifficultyCalculatorTest.cs:30`) and tree B has **no** golden values at all.
6. **`Math.Min(x, 0.6*(x−0.09)+0.09)`** (`SunnySkill.cs:69`) — do not "simplify" into a clamp; it is `min(x, 0.6x+0.036)`, active only above `x = 0.09`.
7. **`jackNerfer` singularity:** `1 − 7e-5·Math.Pow(0.15 + Math.Abs(δ − 0.08), -4)` (:291). The `0.15 +` makes the minimum distance 0.15, so the term is bounded (`≈ 1 − 0.0138`), but do not reorder the `Math.Pow`.
8. **`Math.Pow(negative, fractional)` → NaN**, e.g. `Math.Pow(0.08*(1/x)*(1 − lambda_3*(1/x)*Math.Pow(delta − x/2, 2)), 0.25)` (:580) when the inner factor goes negative. **.NET and Rust Min/Max disagree on NaN propagation:** .NET `Math.Min`/`Math.Max` return NaN if *either* argument is NaN ([docs](https://learn.microsoft.com/en-us/dotnet/api/system.math.min?view=net-10.0): *"If val1, val2, or both val1 and val2 are equal to NaN, NaN is returned"*), while Rust `f64::min`/`f64::max` return the non-NaN operand ([Rust docs](https://doc.rust-lang.org/std/primitive.f64.html)). Reproduce the .NET behaviour explicitly.
9. **The `1e-6` probe is applied *before* the HR/EZ division** (`ManiaDifficultyCalculator.cs:151-157`), so it is amplified by `×1.4` and can cross a `floor` boundary. Keep the position.
10. **Sentinels that must survive refactoring:** `delta_ks` initialised to `1e9` (:306) feeds the `1/δ` weights (an untouched column ends up with weight `1e-9`); `Math.Max(1e-9, den)` (:359) and `Math.Max(cntActive, 1)` (:795) are deliberate divide-by-zero guards. Do not substitute 0 or a "nicer" epsilon.
11. **`denWeighted` snapshot** at :918 is reused as `variance_sum_bottom`; do not recompute it after any mutation.

**Semantics / defaults / ordering**
12. **`Tail = -1` for rice** (`SunnySkill.cs:54`). An `Option<f64>` is cleaner but must reproduce that rice notes **do** appear in `Variety`'s `tailSeq` (:1163-1164) yet not in `LNSeq` (:99). The rice test is `EndTime == StartTime` **after** truncating to `int`.
13. **The first hit object is dropped** by `for (int i = 1; …)` in `CreateDifficultyHitObjects` (A :81, B :81): `SunnySkill.noteSeq.Count == N − 1` while `ManiaDifficultyAttributes.TotalNotes == N`. Reproduce the off-by-one; do not "fix" it in only one of the two places.
14. **Empty/degenerate inputs.** `if (noteSeq.Count <= 0) return 0;` (`SunnySkill.cs:65-66`) short-circuits before `MACalculator.Calculate`, but the pp multipliers still run on zeroed metrics. Both difficulty calculators return `new ManiaDifficultyAttributes { Mods = mods }` with `StarRating = 0` for an empty beatmap (A :42-43, B :41-42) → tree B then computes `lengthMultiplier = 1.1/(1 + Math.Sqrt(0/(2*0)))` = **0/0 → NaN**.
15. **Ordering assumptions.** Tree A's unstable `LegacySortHelper` keyed on `(int)Math.Round(StartTime)` (`LegacySortHelper.cs`) is what makes chord handling match live; Rust's `sort_unstable_by_key` is a different algorithm, so equal keys reorder → different `LastObject`/`DeltaTime` → different `PreviousHitObjects` fill order. `MACalculator` also uses the unstable `List<T>.Sort` (:71-75) by `(Head, Column)`, and `Variety`/`Switches` reuse that mutated order. Pin one canonical total order (or a stable sort) and document it.
16. **`MACalculator.Calculate` mutates its inputs** (`noteSeq` sort + `Note.ColumnIndex` write-back). A `&[Note]` signature cannot; either take `&mut` or pre-normalise and guarantee idempotence across repeated calls.
17. **Monotone-pointer walks assume sorted scan order** — J `pointer` (:314), X `pointer` (:416), P `pointerP` (:550), R `previous_idx_start` (:705). One out-of-order note silently drops the rest of that walk; do not replace them with binary searches "for safety" (they agree only because the input is sorted).
18. **`Array.BinarySearch` semantics.** `LowerBound(double[], value)` (:1209-1214) returns the **exact** index when present, else `~insertionPoint` — *not* a true `lower_bound` under duplicates. `StepInterp` (:1023-1041) does `idx − 1` after the search and clamps to `[0, len−1]`; `InterpValues` (:998-1020) clamps outside the range. Rust's `partition_point` differs — implement the .NET behaviour explicitly.
19. **`Array.FindIndex(normCumWeights, cw => cw >= tp)`** (:876) = the first index whose *cumulative weight fraction* reaches the target, else `sortedList.Count − 1`. Because `Weight` can be `0` (empty windows), `normCumWeights` can plateau — "first index" matters.
20. **`Variety` weights sum to 1.06**, and `RaoQuadraticEntropyLog` iterates a `Dictionary<int,int>` whose enumeration order feeds a symmetric double loop — the floating-point sum order is not canonical.
21. **Caches / memoisation.** `SunnySkill.DifficultyValue()` recomputes the whole `MACalculator.Calculate` on every call and depends on `noteSeq` order, and `spikiness`/`switches` are side-effects of that call — memoising SR is safe only if the input list is frozen, and the metrics must come from the *same* invocation that produced `StarRating`. `ManiaDifficultyCalculator` re-runs the full skill per mod combination; neither tree memoises anything.
22. **Do not wire the discarded `hitWindows`** from tree A (`ManiaDifficultyCalculator.cs:45-46`) into SR.
23. **Serialised field names** (for round-tripping attributes): `star_rating`, `max_combo` (base) plus tree B's `great_hit_window`, `variety`, `acc_scalar`, `total_notes` (`B:.../ManiaDifficultyAttributes.cs:19-29`) and `difficulty`, `variety_multiplier`, `acc_multiplier`, `length_multiplier` (`B:.../ManiaPerformanceAttributes.cs:12-22`).

## C.2 Minimum call-graph — bancho (tree A)
**(a) Star rating for a parsed beatmap + mods**
```
ManiaRuleset.CreateDifficultyCalculator(beatmap)                     ManiaRuleset.cs:320
 -> new ManiaDifficultyCalculator(rulesetInfo, beatmap)
 -> DifficultyCalculator.Calculate(mods)          A:osu.Game/Rulesets/Difficulty/DifficultyCalculator.cs
    -> preProcess: GetPlayableBeatmap(ruleset, mods)  (applies CL/SV2 windows, HR/EZ window multipliers, key mods)
       clockRate = ModUtils.CalculateRateWithMods(mods)             ModUtils.cs:288
    -> CreateDifficultyHitObjects(beatmap, mods)                    ManiaDifficultyCalculator.cs:66-89
         LegacySortHelper.Sort by (int)Math.Round(StartTime)        :73
         for i in 1..N-1: new ManiaDifficultyHitObject(...)         :81-86
    -> for each dho: Strain.Process(dho)                            Strain.cs:33-49
         -> IndividualStrainEvaluator.EvaluateDifficultyOf          Evaluators/IndividualStrainEvaluator.cs
         -> OverallStrainEvaluator.EvaluateDifficultyOf             Evaluators/OverallStrainEvaluator.cs
    -> CreateDifficultyAttributes(...)                              :40-56
         StarRating = Strain.DifficultyValue() * 0.018              :50   (0.9^rank weighted section peaks)
         MaxCombo   = Σ maxComboForObject                           :52,58-64
```
**(b) PP for a score** (only `StarRating` is read from the attributes)
```
new ManiaPerformanceCalculator().Calculate(scoreInfo, maniaAttributes)   ManiaPerformanceCalculator.cs:29
 -> counts from score.Statistics                                          :33-38
 -> calculateCustomAccuracy() = (320P+300G+200Good+100Ok+50Meh)/(totalHits*320)   :72-78
 -> multiplier = 1.0 * (NF ? 0.75) * (EZ ? 0.5)                           :41-46
 -> 8.0 * Math.Pow(Math.Max(StarRating - 0.15, 0.05), 2.2)                :60
      * Math.Max(0, 5*acc - 4)                                            :61
      * (1 + 0.1 * Math.Min(1, totalHits / 1500))                         :62
 -> Total = Difficulty * multiplier                                       :49
```
**(c) Score / health (not pp):** `ManiaScoreMultiplierCalculator` (`ManiaRuleset.cs:310`, A.5) and`ManiaHealthProcessor` (`ManiaRuleset.cs:57`, A.6). Tree A's mania `StarRating` is **not** interchangeable withsunny's `StarRating` — the two pipelines share only the field name.

## C.3 Minimum call-graph — sunny (tree B)
**(a) Star rating**
```
ManiaRuleset.CreateDifficultyCalculator(beatmap)                  B:ManiaRuleset.cs:315
 -> new ManiaDifficultyCalculator(rulesetInfo, beatmap)
 -> DifficultyCalculator.Calculate(mods)            B:osu.Game/Rulesets/Difficulty/DifficultyCalculator.cs:63
    -> preProcess -> clockRate (from IApplicableToTrack rates)      :169-182
    -> CreateDifficultyHitObjects(beatmap, clockRate)               B:ManiaDifficultyCalculator.cs:71-89
         OrderBy(obj => obj.StartTime).ThenBy(obj => Column)  (LINQ stable)  :75
         for i in 1..N-1 -> new ManiaDifficultyHitObject            :81-86
    -> CreateSkills(...) -> new SunnySkill(mods, columns,           :94-97
              beatmap.Difficulty.OverallDifficulty, HitObjects.Count,
              getHitWindow300(mods, clockRate))                     :135-159
    -> for each dho: SunnySkill.Process(dho)                        SunnySkill.cs:50-61
    -> CreateDifficultyAttributes(...)   ** source order matters ** :39-61
         1. StarRating = SunnySkill.DifficultyValue()               SunnySkill.cs:63-76
              x = 0.3*sqrt(greatHitWindow/500); x = min(x, 0.6(x-0.09)+0.09)      :68-69
              MACalculator.Calculate(noteSeq, noteSeqByColumn, columns, x, CL)    MACalculator.cs:56
                 -> SR/Spikiness/Switches                                         :907-928
         2. Variety    = SunnySkill.VarietyValue()                  :78-81  -> MACalculator.Variety :1160
         3. AccScalar  = SunnySkill.AccScalarValue()                :83-86
         4. TotalNotes = beatmap.HitObjects.Count                   :52
         5. GreatHitWindow = getHitWindow300(...)                   :56,135-159
```
**(b) PP for a score**
```
new ManiaPerformanceCalculator().Calculate(scoreInfo, maniaAttributes)   B:ManiaPerformanceCalculator.cs:29
 -> counts from score.Statistics (P/G/Good/Ok/Meh/Miss)                   :33-38
 -> acc = (305P + 300G + 200Good + 100Ok + 50Meh)/(totalHits*305)         :80-86   (no clamp)
 -> proportion = acc > 0.8 ? 4.5(acc-0.8)/(100(1-acc)+0.9^20)^0.05 : 0    :88-95
 -> difficultyValue = 9.8 * Math.Pow(Math.Max(SR-0.15, 0.05), 2.2) * proportion   :64-73
 -> varietyMultiplier = 0.945 + 0.11/(1+exp(-3(variety-3.25)))                    :97-107
 -> accMultiplier = s*(2acc^20-1) + 2-2acc^20,  s = 0.87+0.26/(1+exp(-20(accScalar-1)))  :109-113
 -> lengthMultiplier = 1.1/(1+sqrt(SR/(2*TotalNotes)))                           :115-118
 -> multiplier = (NF ? 0.75) * (EZ ? 0.90)                                       :41-46
 -> Total = difficultyValue * multiplier * varietyMultiplier * accMultiplier * lengthMultiplier   :52
```
Required attribute fields: `StarRating`, `Variety`, `AccScalar`, `TotalNotes`(`B:.../ManiaDifficultyAttributes.cs:19-29`).

## C.4 Explicit gaps
- **Tree A:** no mania pp test / golden pp values — **NOT FOUND** (grepped `ManiaPerformanceCalculator`, `ManiaPerformanceAttributes` tree-wide; only the class files and `ManiaRuleset.cs:61`). Star-rating goldens exist (A.9).
- **Tree B:** no golden values for sunny SR or sunny PP — **NOT FOUND** (case-insensitive `sunny` over the tree matches only `SunnySkill.cs` and `ManiaDifficultyCalculator.cs`; no sunny test fixture).
- **Tree B:** no `ManiaScoreMultiplierCalculator`, no `ManiaModScoreV2`, no CHANGELOG/version marker → forked upstream revision **NOT FOUND**.
- **Both trees:** the original sunny JavaScript/TypeScript reference is **not present** in either tree, so the author port cannot be diffed against its JS original from these sources alone.
- **Tree B:** `SunnySkill.od` is assigned and never read — any "OD affects sunny" claim must go through `GreatHitWindow`/`x`, never through `od`.
