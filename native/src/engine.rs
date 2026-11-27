//! Match summary and clip poses, using the same demoparser crate the Python
//! extension wraps. Pandas is not in this path.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ahash::AHashMap;
use memmap2::MmapOptions;
use parser::first_pass::parser_settings::ParserInputs;
use parser::first_pass::prop_controller::{
    ENTITY_ID_ID, GAME_TIME_ID, GRENADE_TYPE_ID, GRENADE_X, GRENADE_Y, GRENADE_Z, IS_ALIVE_ID, NAME_ID,
    PITCH_ID, PLAYER_X_ID, PLAYER_Y_ID, PLAYER_Z_ID, STEAMID_ID, TICK_ID, USERID_ID, YAW_ID,
};
use parser::parse_demo::{Parser, ParsingMode};
use parser::second_pass::game_events::GameEvent;
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::{PropColumn, VarVec, Variant};
use serde::{Deserialize, Serialize};

const STEAMID64_BASE: u64 = 76561197960265728;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Kill {
    pub tick: i32,
    pub round_index: i32,
    pub attacker_steamid: String,
    pub attacker_name: String,
    pub victim_name: String,
    pub weapon: String,
    pub headshot: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Round {
    pub index: i32,
    pub start_tick: i32,
    pub freeze_end_tick: i32,
    pub end_tick: i32,
    pub winner: String,
    pub ct_score: i32,
    pub t_score: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Moment {
    pub id: String,
    pub name: String,
    pub round: i32,
    pub score: f32,
    pub labels: Vec<String>,
    pub steamid: String,
    pub first_tick: i32,
    pub last_tick: i32,
    pub kills: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MatchSummary {
    pub map: String,
    pub tickrate: f64,
    pub rounds: Vec<Round>,
    pub kills: Vec<Kill>,
    pub slots: BTreeMap<String, i32>,
    pub moments: Vec<Moment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayerPose {
    pub steamid: String,
    pub name: String,
    pub team: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub alive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    pub tick: i32,
    pub players: Vec<PlayerPose>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shot {
    pub tick: i32,
    pub steamid: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Point {
    pub tick: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grenade {
    pub kind: String,
    pub points: Vec<Point>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Clip {
    pub label: String,
    pub round: i32,
    pub score: f32,
    pub pov: String,
    pub start_tick: i32,
    pub end_tick: i32,
    pub tickrate: f64,
    pub frames: Vec<Frame>,
    pub shots: Vec<Shot>,
    pub grenades: Vec<Grenade>,
}

pub struct Timings {
    pub parse_seconds: f64,
    pub preview_seconds: f64,
    pub second_seconds: f64,
    pub reopen_seconds: f64,
}

fn cache_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let path = PathBuf::from(home).join(".cs2-reel").join("native");
    let _ = std::fs::create_dir_all(&path);
    path
}

fn stamp(path: &Path) -> String {
    let meta = std::fs::metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let len = meta.map(|m| m.len()).unwrap_or(0);
    format!("{modified}-{len}")
}

pub fn preview_window(first: i32, last: i32, tickrate: f64) -> (i32, i32) {
    let rate = if tickrate > 0.0 { tickrate } else { 64.0 };
    let start = (first as f64 - 4.0 * rate).floor().max(96.0) as i32;
    let end = (last as f64 + 3.0 * rate).floor() as i32;
    (start, end)
}

fn parse_with(
    bytes: &[u8],
    props: &[&str],
    events: &[&str],
    ticks: &[i32],
    grenades: bool,
) -> Result<parser::parse_demo::DemoOutput, String> {
    let huf = create_huffman_lookup_table();
    let settings = ParserInputs {
        real_name_to_og_name: AHashMap::default(),
        wanted_players: vec![],
        wanted_player_props: props.iter().map(|s| (*s).to_string()).collect(),
        wanted_other_props: vec!["is_warmup_period".into()],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: ticks.to_vec(),
        wanted_events: events.iter().map(|s| (*s).to_string()).collect(),
        parse_ents: true,
        parse_projectiles: grenades,
        parse_grenades: grenades,
        parse_weapons: false,
        vector_props_as_lists: false,
        only_header: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    };
    Parser::new(settings, ParsingMode::Normal)
        .parse_demo(bytes)
        .map_err(|err| format!("{err:?}"))
}

fn map_file(path: &Path) -> Result<memmap2::Mmap, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    unsafe { MmapOptions::new().map(&file).map_err(|err| err.to_string()) }
}

fn variant_i32(value: &Variant) -> Option<i32> {
    match value {
        Variant::I32(n) => Some(*n),
        Variant::U32(n) => i32::try_from(*n).ok(),
        Variant::F32(n) => Some(*n as i32),
        _ => None,
    }
}

fn variant_f32(value: &Variant) -> Option<f32> {
    match value {
        Variant::F32(n) => Some(*n),
        Variant::I32(n) => Some(*n as f32),
        Variant::U32(n) => Some(*n as f32),
        _ => None,
    }
}

fn variant_bool(value: &Variant) -> bool {
    match value {
        Variant::Bool(v) => *v,
        Variant::I32(n) => *n != 0,
        Variant::U32(n) => *n != 0,
        Variant::String(s) => !matches!(s.to_ascii_lowercase().as_str(), "0" | "false" | "no" | ""),
        _ => false,
    }
}

fn steam_text(value: &Variant) -> String {
    let number = match value {
        Variant::U64(n) => *n,
        Variant::I32(n) if *n > 0 => *n as u64,
        Variant::U32(n) => *n as u64,
        Variant::String(text) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    };
    if number == 0 {
        return String::new();
    }
    let number = if number < STEAMID64_BASE {
        number + STEAMID64_BASE
    } else {
        number
    };
    number.to_string()
}

fn variant_string(value: &Variant) -> String {
    match value {
        Variant::String(text) => text.clone(),
        other => format!("{other:?}"),
    }
}

fn event_field<'a>(event: &'a GameEvent, name: &str) -> Option<&'a Variant> {
    event
        .fields
        .iter()
        .find(|field| field.name == name)
        .and_then(|field| field.data.as_ref())
}

fn side_name(value: &str) -> String {
    let text = value.to_ascii_uppercase();
    if text == "CT" || text.starts_with("COUNTER") || text == "3" {
        "CT".into()
    } else if text.starts_with('T') || text == "2" {
        "T".into()
    } else {
        String::new()
    }
}

fn i32_col(col: &PropColumn) -> Vec<Option<i32>> {
    match &col.data {
        Some(VarVec::I32(values)) => values.clone(),
        Some(VarVec::U32(values)) => values.iter().map(|v| v.and_then(|n| i32::try_from(n).ok())).collect(),
        _ => vec![],
    }
}

fn f32_col(col: &PropColumn) -> Vec<Option<f32>> {
    match &col.data {
        Some(VarVec::F32(values)) => values.clone(),
        _ => vec![],
    }
}

fn bool_col(col: &PropColumn) -> Vec<Option<bool>> {
    match &col.data {
        Some(VarVec::Bool(values)) => values.clone(),
        _ => vec![],
    }
}

fn u64_col(col: &PropColumn) -> Vec<Option<u64>> {
    match &col.data {
        Some(VarVec::U64(values)) => values.clone(),
        _ => vec![],
    }
}

fn str_col(col: &PropColumn) -> Vec<Option<String>> {
    match &col.data {
        Some(VarVec::String(values)) => values.clone(),
        Some(VarVec::StrDict(dict)) => dict.iter().map(|value| value.map(str::to_string)).collect(),
        _ => vec![],
    }
}

fn column<'a>(output: &'a parser::parse_demo::DemoOutput, name: &str) -> Option<&'a PropColumn> {
    let special = match name {
        "X" => Some(PLAYER_X_ID),
        "Y" => Some(PLAYER_Y_ID),
        "Z" => Some(PLAYER_Z_ID),
        "pitch" => Some(PITCH_ID),
        "yaw" => Some(YAW_ID),
        "is_alive" => Some(IS_ALIVE_ID),
        "game_time" => Some(GAME_TIME_ID),
        "user_id" => Some(USERID_ID),
        _ => None,
    };
    if let Some(id) = special {
        if let Some(column) = output.df.get(&id) {
            return Some(column);
        }
    }
    let id = output
        .prop_controller
        .prop_infos
        .iter()
        .find(|info| info.prop_friendly_name == name || info.prop_name == name)
        .map(|info| info.id)?;
    output.df.get(&id)
}

fn at<T: Clone>(values: &[Option<T>], index: usize) -> Option<T> {
    values.get(index).cloned().flatten()
}

pub fn parse_match(path: &Path) -> Result<MatchSummary, String> {
    let mmap = map_file(path)?;
    let started = Instant::now();
    let output = parse_with(
        &mmap,
        &[],
        &[
            "begin_new_match",
            "player_death",
            "round_start",
            "round_end",
            "round_freeze_end",
            "player_hurt",
        ],
        &[],
        false,
    )?;
    let events_seconds = started.elapsed().as_secs_f64();
    let header_map = output.header.as_ref();
    let map = header_map
        .and_then(|header| header.get("map_name"))
        .cloned()
        .unwrap_or_else(|| "unknown".into());

    let match_start = output
        .game_events
        .iter()
        .filter(|event| event.name == "begin_new_match")
        .map(|event| event.tick)
        .max()
        .unwrap_or(0);

    let mut starts: Vec<i32> = output
        .game_events
        .iter()
        .filter(|event| event.name == "round_start")
        .map(|event| event.tick)
        .collect();
    starts.sort_unstable();
    let mut freezes: Vec<i32> = output
        .game_events
        .iter()
        .filter(|event| event.name == "round_freeze_end")
        .map(|event| event.tick)
        .collect();
    freezes.sort_unstable();

    let mut ends: Vec<&GameEvent> = output
        .game_events
        .iter()
        .filter(|event| event.name == "round_end")
        .collect();
    ends.sort_by_key(|event| event.tick);

    let mut rounds = Vec::new();
    let mut ct_score = 0;
    let mut t_score = 0;
    for event in ends {
        if event.tick < match_start {
            continue;
        }
        let start_tick = starts.iter().rev().find(|tick| **tick <= event.tick).copied().unwrap_or(match_start);
        let freeze_end = freezes
            .iter()
            .rev()
            .find(|tick| **tick >= start_tick && **tick <= event.tick)
            .copied()
            .unwrap_or(start_tick);
        let winner_raw = event_field(event, "winner").map(variant_string).unwrap_or_default();
        let winner = side_name(&winner_raw);
        if winner == "CT" {
            ct_score += 1;
        } else if winner == "T" {
            t_score += 1;
        }
        rounds.push(Round {
            index: rounds.len() as i32,
            start_tick,
            freeze_end_tick: freeze_end,
            end_tick: event.tick,
            winner,
            ct_score,
            t_score,
        });
    }

    let mut kills = Vec::new();
    for event in output.game_events.iter().filter(|event| event.name == "player_death") {
        if event.tick < match_start {
            continue;
        }
        if event_field(event, "is_warmup_period").is_some_and(variant_bool) {
            continue;
        }
        let victim = event_field(event, "user_steamid").map(steam_text).unwrap_or_default();
        let attacker = event_field(event, "attacker_steamid").map(steam_text).unwrap_or_default();
        if attacker.is_empty() || attacker == victim {
            continue;
        }
        let attacker_side = side_name(
            &event_field(event, "attacker_team_name")
                .map(variant_string)
                .unwrap_or_default(),
        );
        let victim_side = side_name(
            &event_field(event, "user_team_name")
                .map(variant_string)
                .unwrap_or_default(),
        );
        if !attacker_side.is_empty() && attacker_side == victim_side {
            continue;
        }
        let round_index = rounds
            .iter()
            .rev()
            .find(|round| event.tick >= round.start_tick)
            .map(|round| round.index)
            .unwrap_or(0);
        kills.push(Kill {
            tick: event.tick,
            round_index,
            attacker_steamid: attacker,
            attacker_name: event_field(event, "attacker_name")
                .map(variant_string)
                .unwrap_or_default(),
            victim_name: event_field(event, "user_name").map(variant_string).unwrap_or_default(),
            weapon: event_field(event, "weapon").map(variant_string).unwrap_or_default(),
            headshot: event_field(event, "headshot").is_some_and(variant_bool),
        });
    }
    kills.sort_by_key(|kill| kill.tick);

    let tickrate = tickrate_from_deaths(path, &kills)?;
    let slots = sample_slots(path, rounds.first().map(|round| round.freeze_end_tick + 16).unwrap_or(128))?;
    let moments = cluster_moments(&kills, &rounds, tickrate);
    let _ = events_seconds;
    Ok(MatchSummary {
        map,
        tickrate,
        rounds,
        kills,
        slots,
        moments,
    })
}

fn tickrate_from_deaths(path: &Path, kills: &[Kill]) -> Result<f64, String> {
    if kills.len() < 2 {
        return Ok(64.0);
    }
    let t1 = kills.iter().map(|kill| kill.tick).min().unwrap();
    let t2 = kills.iter().map(|kill| kill.tick).max().unwrap();
    if t2 - t1 < 256 {
        return Ok(64.0);
    }
    let mmap = map_file(path)?;
    let output = parse_with(&mmap, &["game_time"], &[], &[t1, t2], false)?;
    let Some(ticks) = output.df.get(&TICK_ID).map(i32_col) else {
        return Ok(64.0);
    };
    let Some(times) = column(&output, "game_time").map(f32_col) else {
        return Ok(64.0);
    };
    let mut first = None;
    let mut last = None;
    for (tick, time) in ticks.iter().zip(times.iter()) {
        let (Some(tick), Some(time)) = (tick, time) else { continue };
        if *tick == t1 {
            first = Some(*time);
        }
        if *tick == t2 {
            last = Some(*time);
        }
    }
    match (first, last) {
        (Some(a), Some(b)) if b > a => {
            let rate = (t2 - t1) as f64 / (b - a) as f64;
            if (16.0..256.0).contains(&rate) {
                Ok(rate.round())
            } else {
                Ok(64.0)
            }
        }
        _ => Ok(64.0),
    }
}

fn sample_slots(path: &Path, tick: i32) -> Result<BTreeMap<String, i32>, String> {
    let mmap = map_file(path)?;
    let output = parse_with(&mmap, &["user_id"], &[], &[tick], false)?;
    let ticks = output.df.get(&TICK_ID).map(i32_col).unwrap_or_default();
    let steamids = output.df.get(&STEAMID_ID).map(u64_col).unwrap_or_default();
    let users = column(&output, "user_id").map(i32_col).unwrap_or_default();
    let mut slots = BTreeMap::new();
    for index in 0..ticks.len() {
        if at(&ticks, index) != Some(tick) {
            continue;
        }
        let Some(steamid) = at(&steamids, index) else { continue };
        let Some(user_id) = at(&users, index) else { continue };
        if steamid == 0 {
            continue;
        }
        let id = if steamid < STEAMID64_BASE {
            steamid + STEAMID64_BASE
        } else {
            steamid
        };
        slots.insert(id.to_string(), user_id + 1);
    }
    Ok(slots)
}

fn cluster_moments(kills: &[Kill], rounds: &[Round], tickrate: f64) -> Vec<Moment> {
    let gap = (20.0 * tickrate) as i32;
    let mut by_player: BTreeMap<(String, i32), Vec<&Kill>> = BTreeMap::new();
    for kill in kills {
        by_player
            .entry((kill.attacker_steamid.clone(), kill.round_index))
            .or_default()
            .push(kill);
    }
    let mut moments = Vec::new();
    for ((steamid, round_index), group) in by_player {
        let mut cluster: Vec<&Kill> = Vec::new();
        let flush = |cluster: &[&Kill], moments: &mut Vec<Moment>| {
            if cluster.is_empty() {
                return;
            }
            let kills_n = cluster.len();
            let mut labels = Vec::new();
            if kills_n >= 5 {
                labels.push("ACE".into());
            } else if kills_n == 4 {
                labels.push("4K".into());
            } else if kills_n == 3 {
                labels.push("3K".into());
            }
            let score = kills_n as f32 * 2.0 + cluster.iter().filter(|kill| kill.headshot).count() as f32 * 0.4;
            moments.push(Moment {
                id: format!("{steamid}-{round_index}-{}", cluster[0].tick),
                name: cluster[0].attacker_name.clone(),
                round: round_index + 1,
                score,
                labels,
                steamid: steamid.clone(),
                first_tick: cluster[0].tick,
                last_tick: cluster.last().unwrap().tick,
                kills: kills_n,
            });
        };
        for kill in group {
            if let Some(prev) = cluster.last() {
                if kill.tick - prev.tick > gap {
                    flush(&cluster, &mut moments);
                    cluster.clear();
                }
            }
            cluster.push(kill);
        }
        flush(&cluster, &mut moments);
    }
    moments.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let _ = rounds;
    moments
}

#[derive(Serialize, Deserialize)]
struct SharedCache {
    events: Vec<CachedEvent>,
    grenades: Vec<PointRow>,
}

#[derive(Serialize, Deserialize)]
struct CachedEvent {
    name: String,
    tick: i32,
    steamid: String,
    weapon: String,
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Serialize, Deserialize)]
struct PointRow {
    entity: i32,
    kind: String,
    tick: i32,
    x: f32,
    y: f32,
    z: f32,
}

fn shared_cache_path(demo: &Path) -> PathBuf {
    cache_dir().join(format!("shared-{}.bin", stamp(demo)))
}

fn load_shared(demo: &Path) -> Result<SharedCache, String> {
    let path = shared_cache_path(demo);
    if path.is_file() {
        let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
        if let Ok(cache) = bincode::deserialize::<SharedCache>(&bytes) {
            return Ok(cache);
        }
    }
    let mmap = map_file(demo)?;
    let events_out = parse_with(
        &mmap,
        &[],
        &["fire_bullets", "weapon_fire"],
        &[],
        false,
    )?;
    let mut events = Vec::new();
    for event in &events_out.game_events {
        if event.name != "fire_bullets" && event.name != "weapon_fire" {
            continue;
        }
        let steamid = event_field(event, "user_steamid")
            .or_else(|| event_field(event, "attacker_steamid"))
            .map(steam_text)
            .unwrap_or_default();
        events.push(CachedEvent {
            name: event.name.clone(),
            tick: event.tick,
            steamid,
            weapon: event_field(event, "weapon").map(variant_string).unwrap_or_default(),
            x: event_field(event, "x").and_then(variant_f32).unwrap_or(0.0),
            y: event_field(event, "y").and_then(variant_f32).unwrap_or(0.0),
            z: event_field(event, "z").and_then(variant_f32).unwrap_or(0.0),
        });
    }
    let grenade_out = parse_with(&mmap, &[], &[], &[], true)?;
    let ticks = grenade_out.df.get(&TICK_ID).map(i32_col).unwrap_or_default();
    let entities = grenade_out.df.get(&ENTITY_ID_ID).map(i32_col).unwrap_or_default();
    let xs = grenade_out.df.get(&GRENADE_X).map(f32_col).unwrap_or_default();
    let ys = grenade_out.df.get(&GRENADE_Y).map(f32_col).unwrap_or_default();
    let zs = grenade_out.df.get(&GRENADE_Z).map(f32_col).unwrap_or_default();
    let kinds = grenade_out.df.get(&GRENADE_TYPE_ID).map(str_col).unwrap_or_default();
    let mut grenades = Vec::new();
    for index in 0..ticks.len() {
        let (Some(tick), Some(entity), Some(x), Some(y), Some(z)) = (
            at(&ticks, index),
            at(&entities, index),
            at(&xs, index),
            at(&ys, index),
            at(&zs, index),
        ) else {
            continue;
        };
        let kind = at(&kinds, index).unwrap_or_default();
        if !kind.ends_with("Projectile") {
            continue;
        }
        grenades.push(PointRow { entity, kind, tick, x, y, z });
    }
    let cache = SharedCache { events, grenades };
    if let Ok(bytes) = bincode::serialize(&cache) {
        let _ = std::fs::write(path, bytes);
    }
    Ok(cache)
}

fn pose_cache_path(demo: &Path, start: i32, end: i32, pov: &str) -> PathBuf {
    cache_dir().join(format!("pose-{}-{}-{}-{}.json", stamp(demo), start, end, pov))
}

pub fn load_clip(path: &Path) -> Result<Clip, String> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    serde_json::from_slice(&bytes).map_err(|err| err.to_string())
}

pub fn preview_clip(demo: &Path, summary: &MatchSummary, moment: &Moment) -> Result<(Clip, bool), String> {
    let (start, end) = preview_window(moment.first_tick, moment.last_tick, summary.tickrate);
    let cache = pose_cache_path(demo, start, end, &moment.steamid);
    if cache.is_file() {
        return Ok((load_clip(&cache)?, true));
    }
    let shared = load_shared(demo)?;
    let ticks: Vec<i32> = (start..=end).step_by(2).collect();
    let mmap = map_file(demo)?;
    let output = parse_with(
        &mmap,
        &[
            "X",
            "Y",
            "Z",
            "pitch",
            "yaw",
            "is_alive",
            "health",
            "team_num",
            "active_weapon_name",
        ],
        &[],
        &ticks,
        false,
    )?;
    let tick_col = output.df.get(&TICK_ID).map(i32_col).unwrap_or_default();
    let steam_col = output.df.get(&STEAMID_ID).map(u64_col).unwrap_or_default();
    let name_col = output.df.get(&NAME_ID).map(str_col).unwrap_or_default();
    let xs = column(&output, "X").map(f32_col).unwrap_or_default();
    let ys = column(&output, "Y").map(f32_col).unwrap_or_default();
    let zs = column(&output, "Z").map(f32_col).unwrap_or_default();
    let yaws = column(&output, "yaw").map(f32_col).unwrap_or_default();
    let alive = column(&output, "is_alive").map(bool_col).unwrap_or_default();
    let health = column(&output, "health").map(f32_col).unwrap_or_default();
    let teams = column(&output, "team_num").map(i32_col).unwrap_or_default();
    if xs.is_empty() {
        return Err("no player positions in this clip".into());
    }

    let mut grouped: BTreeMap<i32, Vec<PlayerPose>> = BTreeMap::new();
    for index in 0..tick_col.len() {
        let Some(tick) = at(&tick_col, index) else { continue };
        let Some(raw_id) = at(&steam_col, index) else { continue };
        if raw_id == 0 {
            continue;
        }
        let steamid = if raw_id < STEAMID64_BASE {
            raw_id + STEAMID64_BASE
        } else {
            raw_id
        }
        .to_string();
        let health = at(&health, index).unwrap_or(100.0);
        let mut alive = at(&alive, index).unwrap_or(true);
        if health <= 0.0 {
            alive = false;
        }
        let team = match at(&teams, index).unwrap_or(0) {
            2 => "T",
            3 => "CT",
            _ => "",
        };
        grouped.entry(tick).or_default().push(PlayerPose {
            steamid,
            name: at(&name_col, index).unwrap_or_default(),
            team: team.into(),
            x: at(&xs, index).unwrap_or(0.0),
            y: at(&ys, index).unwrap_or(0.0),
            z: at(&zs, index).unwrap_or(0.0),
            yaw: at(&yaws, index).unwrap_or(0.0),
            alive,
        });
    }
    let frames = grouped
        .into_iter()
        .map(|(tick, players)| Frame { tick, players })
        .collect::<Vec<_>>();

    let mut pose_at: AHashMap<(String, i32), (f32, f32, f32)> = AHashMap::default();
    for frame in &frames {
        for player in &frame.players {
            pose_at.insert((player.steamid.clone(), frame.tick), (player.x, player.y, player.z));
        }
    }
    let mut shots = Vec::new();
    for event in shared.events.iter().filter(|event| event.name == "fire_bullets") {
        if event.tick < start || event.tick > end || event.steamid.is_empty() {
            continue;
        }
        let sample = ticks.iter().rev().find(|tick| **tick <= event.tick).copied().unwrap_or(start);
        let (x, y, z) = pose_at
            .get(&(event.steamid.clone(), sample))
            .copied()
            .unwrap_or((event.x, event.y, event.z));
        shots.push(Shot {
            tick: event.tick,
            steamid: event.steamid.clone(),
            x,
            y,
            z,
        });
    }

    let mut by_entity: BTreeMap<i32, Vec<&PointRow>> = BTreeMap::new();
    for row in &shared.grenades {
        if row.tick < start || row.tick > end {
            continue;
        }
        by_entity.entry(row.entity).or_default().push(row);
    }
    let mut grenades = Vec::new();
    for rows in by_entity.values() {
        let mut points = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            if index % 2 == 0 || index + 1 == rows.len() {
                points.push(Point {
                    tick: row.tick,
                    x: row.x,
                    y: row.y,
                    z: row.z,
                });
            }
        }
        if points.len() < 2 {
            continue;
        }
        let raw = rows[0].kind.to_ascii_lowercase();
        let kind = if raw.contains("flash") {
            "flash"
        } else if raw.contains("smoke") {
            "smoke"
        } else if raw.contains("molotov") || raw.contains("incendiary") || raw.contains("inferno") {
            "molotov"
        } else if raw.contains("decoy") {
            "decoy"
        } else if raw.contains("he") || raw.contains("frag") {
            "he"
        } else {
            "other"
        };
        grenades.push(Grenade {
            kind: kind.into(),
            points,
        });
    }

    let clip = Clip {
        label: format!("R{} {} {}", moment.round, moment.name, moment.labels.join(" ")),
        round: moment.round,
        score: moment.score,
        pov: moment.steamid.clone(),
        start_tick: start,
        end_tick: end,
        tickrate: summary.tickrate,
        frames,
        shots,
        grenades,
    };
    if let Ok(bytes) = serde_json::to_vec(&clip) {
        let _ = std::fs::write(cache, bytes);
    }
    Ok((clip, false))
}

pub fn best_moment(summary: &MatchSummary) -> Result<&Moment, String> {
    summary
        .moments
        .iter()
        .max_by(|a, b| a.kills.cmp(&b.kills).then(a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal)))
        .ok_or_else(|| "no highlights".into())
}

pub fn bench(demo: &Path) -> Result<(MatchSummary, Clip, Timings), String> {
    let started = Instant::now();
    let summary = parse_match(demo)?;
    let parse_seconds = started.elapsed().as_secs_f64();
    let moment = best_moment(&summary)?.clone();
    let second = summary
        .moments
        .iter()
        .find(|item| item.id != moment.id && (item.last_tick < moment.first_tick - 64 || item.first_tick > moment.last_tick + 64))
        .cloned()
        .unwrap_or_else(|| moment.clone());

    let _ = std::fs::remove_dir_all(cache_dir());
    let _ = std::fs::create_dir_all(cache_dir());

    let started = Instant::now();
    let (clip, _) = preview_clip(demo, &summary, &moment)?;
    let preview_seconds = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let _ = preview_clip(demo, &summary, &second)?;
    let second_seconds = started.elapsed().as_secs_f64();

    let started = Instant::now();
    let (again, cached) = preview_clip(demo, &summary, &moment)?;
    let reopen_seconds = started.elapsed().as_secs_f64();
    if !cached || again.frames.len() != clip.frames.len() {
        return Err("reopen did not use the pose cache".into());
    }
    Ok((
        summary,
        clip,
        Timings {
            parse_seconds,
            preview_seconds,
            second_seconds,
            reopen_seconds,
        },
    ))
}
