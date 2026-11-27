mod engine;
mod view;

use std::env;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use engine::{bench, best_moment, parse_match, preview_clip};

fn main() {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "play".into());
    let demo = args.next().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp/cs2-demo/match.dem"));
    let result = match command.as_str() {
        "bench" => run_bench(&demo),
        "play" => run_play(&demo),
        other if other.ends_with(".dem") => run_play(&PathBuf::from(other)),
        _ => {
            eprintln!("usage: reel bench [demo] | reel play [demo]");
            std::process::exit(2);
        }
    };
    if let Err(err) = result {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run_play(demo: &std::path::Path) -> Result<(), String> {
    let summary = parse_match(demo)?;
    let moment = best_moment(&summary)?.clone();
    let index = summary.moments.iter().position(|item| item.id == moment.id).unwrap_or(0);
    let (clip, _) = preview_clip(demo, &summary, &moment)?;
    println!(
        "playing {}  frames={} shots={} grenades={}",
        clip.label,
        clip.frames.len(),
        clip.shots.len(),
        clip.grenades.len()
    );
    view::run(demo.to_path_buf(), summary, clip, index)
}

fn run_bench(demo: &std::path::Path) -> Result<(), String> {
    println!("rust");
    let (summary, clip, timings) = bench(demo)?;
    let moved = clip.frames.iter().filter(|frame| frame.players.iter().any(|player| player.alive)).count();
    println!(
        "parse {:.2}s rounds={} kills={} tickrate={}",
        timings.parse_seconds,
        summary.rounds.len(),
        summary.kills.len(),
        summary.tickrate
    );
    println!(
        "preview {:.2}s frames={} shots={} grenades={} alive_frames={}",
        timings.preview_seconds,
        clip.frames.len(),
        clip.shots.len(),
        clip.grenades.len(),
        moved
    );
    println!("second {:.2}s", timings.second_seconds);
    println!("reopen {:.2}s", timings.reopen_seconds);
    if let Some(last) = summary.rounds.last() {
        println!("score {}-{}", last.ct_score, last.t_score);
    }
    println!("label {}", clip.label);

    println!("python");
    let python = Command::new("python3")
        .arg("-m")
        .arg("reel_core")
        .arg("parse")
        .arg(demo)
        .arg("--all-players")
        .arg("-o")
        .arg("/tmp/cs2-demo/payload-compare.json")
        .current_dir("/workspace/core")
        .output()
        .map_err(|err| err.to_string())?;
    if !python.status.success() {
        return Err(String::from_utf8_lossy(&python.stderr).to_string());
    }
    let started = Instant::now();
    let preview = Command::new("python3")
        .arg("/tmp/cs2-demo/preview_one.py")
        .arg(demo)
        .arg(clip.start_tick.to_string())
        .arg(clip.end_tick.to_string())
        .arg(&clip.pov)
        .arg("de_inferno")
        .arg(summary.tickrate.to_string())
        .current_dir("/workspace/core")
        .output()
        .map_err(|err| err.to_string())?;
    println!(
        "python_preview {:.2}s exit={} {}",
        started.elapsed().as_secs_f64(),
        preview.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&preview.stdout).trim()
    );
    if !preview.status.success() {
        println!("{}", String::from_utf8_lossy(&preview.stderr));
    }
    Ok(())
}
