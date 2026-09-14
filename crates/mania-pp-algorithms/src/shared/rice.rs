//! The "rice" variant of a beatmap: every hold rewritten as a plain note.
//!
//! The reimagined algorithm measures its R channel (regular pressing) as the sunny star rating of a map in which holding is not required — only the press remains. Producing that variant from the raw `.osu` text (rather than from a parsed object model) keeps the transformation independent of any dependency's data structures and easy to verify.
//!
//! osu!mania hold lines look like:
//!
//! ```text
//! x,y,time,128,hitSound,endTime:hitSample
//! ```
//!
//! Clearing the hold bit and **setting the circle bit** yields the equivalent tap object at the head time, which is what the research reference does (`(type & ~128) | 1` in its JavaScript tool).
//!
//! ⚠️ The `| 1` is not cosmetic. A mania hold's type is exactly `128`, so clearing the hold bit alone leaves `type = 0`, and the `.osu` decoder treats such a line as invalid and drops the object entirely — the "rice" map silently loses every hold instead of turning it into a tap, and the R channel is then measured on a map that no longer contains those objects at all. [`rice_variant`] therefore guarantees that the object count is preserved, and `prepare` verifies it after parsing.

/// Rewrite every hold as a tap at its head time; everything else is copied verbatim.
pub fn rice_variant(osu_text: &str) -> String {
    let mut out = String::with_capacity(osu_text.len());
    let mut in_hit_objects = false;

    for line in osu_text.lines() {
        let trimmed = line.trim_end();

        if trimmed.starts_with('[') {
            in_hit_objects = trimmed.eq_ignore_ascii_case("[HitObjects]");
            out.push_str(line);
            out.push('\n');
            continue;
        }

        if !in_hit_objects || trimmed.is_empty() || trimmed.starts_with("//") {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        let fields: Vec<&str> = trimmed.split(',').collect();
        if fields.len() >= 5 {
            if let Ok(kind) = fields[3].trim().parse::<i32>() {
                if kind & 128 != 0 {
                    // Keep every other field (hit samples included) and mark the object as a tap: `(type & !128) | 1` — exactly what the research-side tool does.
                    let mut rewritten: Vec<String> =
                        fields.iter().map(|f| (*f).to_owned()).collect();
                    rewritten[3] = ((kind & !128) | 1).to_string();
                    out.push_str(&rewritten.join(","));
                    out.push('\n');
                    continue;
                }
            }
        }

        out.push_str(line);
        out.push('\n');
    }

    out
}
