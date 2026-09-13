//! Infrastructure shared by the algorithm modules.
//!
//! Anything that is not specific to one algorithm lives here: currently the rice variant of a
//! beatmap, which the reimagined algorithm needs for its R channel and which is also the natural
//! place to keep any future "same map, different reading" helper.

pub mod rice;
