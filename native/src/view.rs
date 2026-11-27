//! Native clip player. Players, shots, and grenade paths are drawn with wgpu.
//! The list and the scrubber are egui. There is no web view.

use std::sync::Arc;
use std::time::Instant;

use crate::engine::{preview_clip, Clip, Frame, MatchSummary};
use bytemuck::{Pod, Zeroable};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    pos: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Instance {
    pos: [f32; 3],
    yaw: f32,
    size: [f32; 3],
    color: [f32; 4],
}

struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    uniform_buf: wgpu::Buffer,
    uniform_bind: wgpu::BindGroup,
    box_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
    box_vb: wgpu::Buffer,
    instance_buf: wgpu::Buffer,
    instance_cap: usize,
    line_buf: wgpu::Buffer,
    line_cap: usize,
    egui: egui_winit::State,
    egui_renderer: egui_wgpu::Renderer,
}

struct Player {
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    demo: std::path::PathBuf,
    summary: MatchSummary,
    moment_index: usize,
    clip: Clip,
    tick: f64,
    playing: bool,
    last: Option<Instant>,
    status: String,
}

pub fn run(demo: std::path::PathBuf, summary: MatchSummary, clip: Clip, moment_index: usize) -> Result<(), String> {
    let event_loop = EventLoop::new().map_err(|err| err.to_string())?;
    let tick = clip.start_tick as f64;
    let mut player = Player {
        window: None,
        gpu: None,
        demo,
        summary,
        moment_index,
        clip,
        tick,
        playing: true,
        last: None,
        status: String::new(),
    };
    event_loop.run_app(&mut player).map_err(|err| err.to_string())
}

impl ApplicationHandler for Player {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("Reel")
                        .with_inner_size(LogicalSize::new(1280.0, 800.0)),
                )
                .expect("window"),
        );
        match Gpu::new(window.clone()) {
            Ok(gpu) => {
                self.gpu = Some(gpu);
                self.window = Some(window);
            }
            Err(err) => {
                eprintln!("no gpu: {err}");
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(window) = self.window.clone() else { return };
        let Some(gpu) = self.gpu.as_mut() else { return };
        let response = gpu.egui.on_window_event(&window, &event);
        if response.consumed {
            window.request_redraw();
            return;
        }
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if size.width > 0 && size.height > 0 {
                    gpu.resize(size.width, size.height);
                }
            }
            WindowEvent::RedrawRequested => {
                self.advance();
                if let Err(err) = self.paint() {
                    self.status = err;
                }
                window.request_redraw();
            }
            _ => {}
        }
    }
}

impl Player {
    fn advance(&mut self) {
        let now = Instant::now();
        if self.playing {
            if let Some(last) = self.last {
                let dt = now.duration_since(last).as_secs_f64();
                self.tick += dt * self.clip.tickrate;
                if self.tick >= self.clip.end_tick as f64 {
                    self.tick = self.clip.end_tick as f64;
                    self.playing = false;
                }
            }
        }
        self.last = Some(now);
    }

    fn select(&mut self, index: usize) {
        let Some(moment) = self.summary.moments.get(index).cloned() else { return };
        match preview_clip(&self.demo, &self.summary, &moment) {
            Ok((clip, _)) => {
                self.moment_index = index;
                self.tick = clip.start_tick as f64;
                self.clip = clip;
                self.playing = true;
                self.status.clear();
            }
            Err(err) => self.status = err,
        }
    }

    fn paint(&mut self) -> Result<(), String> {
        let window = self.window.clone().ok_or("window closed")?;
        let mut gpu = self.gpu.take().ok_or("gpu missing")?;
        let result = self.paint_with(&window, &mut gpu);
        self.gpu = Some(gpu);
        result
    }

    fn paint_with(&mut self, window: &Arc<Window>, gpu: &mut Gpu) -> Result<(), String> {
        let frame = match gpu.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Lost) => {
                gpu.resize(gpu.config.width, gpu.config.height);
                return Ok(());
            }
            Err(err) => return Err(err.to_string()),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (camera, player_count, line_count) = {
            let shown = frame_at(&self.clip.frames, self.tick as i32);
            let (players, lines) = scene_geometry(&self.clip, shown, self.tick as i32);
            let counts = (players.len(), lines.len());
            gpu.upload_scene(&players, &lines);
            let pov = shown.and_then(|frame| {
                frame.players.iter().find(|player| player.steamid == self.clip.pov && player.alive)
            });
            (camera_for(pov, shown), counts.0, counts.1)
        };

        let raw_input = gpu.egui.take_egui_input(&window);
        let moments = self.summary.moments.clone();
        let moment_index = self.moment_index;
        let mut tick = self.tick;
        let mut playing = self.playing;
        let start = self.clip.start_tick as f64;
        let end = self.clip.end_tick as f64;
        let label = self.clip.label.clone();
        let status = self.status.clone();
        let frames_n = self.clip.frames.len();
        let shots_n = self.clip.shots.len();
        let nades_n = self.clip.grenades.len();
        let mut jump: Option<usize> = None;
        let egui::FullOutput {
            shapes,
            textures_delta,
            pixels_per_point,
            ..
        } = gpu.egui.egui_ctx().run(raw_input, |ctx| {
            egui::SidePanel::left("clips").exact_width(280.0).show(ctx, |ui| {
                ui.heading("Highlights");
                for (index, moment) in moments.iter().take(12).enumerate() {
                    let text = format!("R{} {} {:.0}k", moment.round, moment.name, moment.kills);
                    if ui.selectable_label(index == moment_index, text).clicked() {
                        jump = Some(index);
                    }
                }
            });
            egui::TopBottomPanel::bottom("scrub").show(ctx, |ui| {
                ui.horizontal(|ui| {
                    if ui.button(if playing { "Pause" } else { "Play" }).clicked() {
                        playing = !playing;
                    }
                    let mut slider = tick as f32;
                    if ui.add(egui::Slider::new(&mut slider, start as f32..=end as f32).show_value(false)).changed() {
                        tick = slider as f64;
                        playing = false;
                    }
                    ui.label(format!("{label}  {frames_n} frames  {shots_n} shots  {nades_n} grenades"));
                    if !status.is_empty() {
                        ui.label(&status);
                    }
                });
            });
        });
        self.tick = tick;
        self.playing = playing;
        if let Some(index) = jump {
            self.select(index);
        }

        let paint_jobs = gpu.egui.egui_ctx().tessellate(shapes, pixels_per_point);
        let screen = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [gpu.config.width, gpu.config.height],
            pixels_per_point,
        };
        for (id, image) in &textures_delta.set {
            gpu.egui_renderer.update_texture(&gpu.device, &gpu.queue, *id, image);
        }
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        gpu.egui_renderer.update_buffers(&gpu.device, &gpu.queue, &mut encoder, &paint_jobs, &screen);

        gpu.write_camera(camera);

        {
            let mut pass = encoder
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.08, g: 0.09, b: 0.11, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            })
            .forget_lifetime();
            pass.set_bind_group(0, &gpu.uniform_bind, &[]);
            pass.set_pipeline(&gpu.box_pipeline);
            pass.set_vertex_buffer(0, gpu.box_vb.slice(..));
            pass.set_vertex_buffer(1, gpu.instance_buf.slice(..));
            pass.draw(0..BOX.len() as u32, 0..player_count as u32);
            if line_count > 0 {
                pass.set_pipeline(&gpu.line_pipeline);
                pass.set_vertex_buffer(0, gpu.line_buf.slice(..));
                pass.draw(0..line_count as u32, 0..1);
            }
            gpu.egui_renderer.render(&mut pass, &paint_jobs, &screen);
        }
        for id in &textures_delta.free {
            gpu.egui_renderer.free_texture(id);
        }
        gpu.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
        Ok(())
    }
}

fn frame_at(frames: &[Frame], tick: i32) -> Option<&Frame> {
    if frames.is_empty() {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = frames.len() - 1;
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if frames[mid].tick <= tick {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Some(&frames[lo])
}

fn cs(x: f32, y: f32, z: f32) -> [f32; 3] {
    [x, z, -y]
}

fn scene_geometry(clip: &Clip, frame: Option<&Frame>, tick: i32) -> (Vec<Instance>, Vec<Vertex>) {
    let mut players = Vec::new();
    if let Some(frame) = frame {
        for player in &frame.players {
            if !player.alive {
                continue;
            }
            let color = if player.team == "CT" {
                [0.35, 0.62, 0.95, 1.0]
            } else if player.steamid == clip.pov {
                [0.95, 0.72, 0.25, 1.0]
            } else {
                [0.90, 0.42, 0.28, 1.0]
            };
            players.push(Instance {
                pos: cs(player.x, player.y, player.z + 36.0),
                yaw: player.yaw.to_radians(),
                size: [32.0, 72.0, 32.0],
                color,
            });
        }
    }
    let mut lines = Vec::new();
    for shot in &clip.shots {
        if (shot.tick - tick).abs() > (clip.tickrate as i32 / 2).max(8) {
            continue;
        }
        let origin = cs(shot.x, shot.y, shot.z + 64.0);
        lines.push(Vertex { pos: origin });
        lines.push(Vertex { pos: [origin[0], origin[1] + 40.0, origin[2]] });
    }
    for grenade in &clip.grenades {
        let visible: Vec<_> = grenade.points.iter().filter(|point| point.tick <= tick).collect();
        for pair in visible.windows(2) {
            lines.push(Vertex { pos: cs(pair[0].x, pair[0].y, pair[0].z) });
            lines.push(Vertex { pos: cs(pair[1].x, pair[1].y, pair[1].z) });
        }
    }
    if let Some(frame) = frame {
        let alive: Vec<_> = frame.players.iter().filter(|player| player.alive).collect();
        if let (Some(min_x), Some(max_x)) = (
            alive.iter().map(|p| p.x).reduce(f32::min),
            alive.iter().map(|p| p.x).reduce(f32::max),
        ) {
            let min_y = alive.iter().map(|p| p.y).reduce(f32::min).unwrap_or(0.0);
            let max_y = alive.iter().map(|p| p.y).reduce(f32::max).unwrap_or(0.0);
            let z = alive.iter().map(|p| p.z).reduce(f32::min).unwrap_or(0.0);
            let a = cs(min_x - 200.0, min_y - 200.0, z);
            let b = cs(max_x + 200.0, min_y - 200.0, z);
            let c = cs(max_x + 200.0, max_y + 200.0, z);
            let d = cs(min_x - 200.0, max_y + 200.0, z);
            for (p, q) in [(a, b), (b, c), (c, d), (d, a)] {
                lines.push(Vertex { pos: p });
                lines.push(Vertex { pos: q });
            }
        }
    }
    (players, lines)
}

fn camera_for(pov: Option<&crate::engine::PlayerPose>, frame: Option<&Frame>) -> Uniforms {
    let (eye, target) = if let Some(player) = pov {
        let yaw = player.yaw.to_radians();
        let look = (yaw.cos(), yaw.sin());
        let focus = cs(player.x, player.y, player.z + 64.0);
        let eye = [
            focus[0] - look.0 * 280.0,
            focus[1] + 160.0,
            focus[2] + look.1 * 280.0,
        ];
        (eye, focus)
    } else if let Some(frame) = frame {
        let alive: Vec<_> = frame.players.iter().filter(|player| player.alive).collect();
        let n = alive.len().max(1) as f32;
        let x = alive.iter().map(|p| p.x).sum::<f32>() / n;
        let y = alive.iter().map(|p| p.y).sum::<f32>() / n;
        let z = alive.iter().map(|p| p.z).sum::<f32>() / n;
        let focus = cs(x, y, z);
        ( [focus[0], focus[1] + 900.0, focus[2] + 40.0], focus)
    } else {
        ([0.0, 400.0, 400.0], [0.0, 0.0, 0.0])
    };
    let aspect = 1280.0 / 800.0;
    Uniforms { view_proj: mul(perspective(0.9, aspect, 8.0, 20000.0), look_at(eye, target)) }
}

fn look_at(eye: [f32; 3], target: [f32; 3]) -> [[f32; 4]; 4] {
    let f = norm(sub(target, eye));
    let s = norm(cross(f, [0.0, 1.0, 0.0]));
    let u = cross(s, f);
    [
        [s[0], u[0], -f[0], 0.0],
        [s[1], u[1], -f[1], 0.0],
        [s[2], u[2], -f[2], 0.0],
        [-dot(s, eye), -dot(u, eye), dot(f, eye), 1.0],
    ]
}

fn perspective(fov: f32, aspect: f32, near: f32, far: f32) -> [[f32; 4]; 4] {
    let f = 1.0 / (fov / 2.0).tan();
    let nf = 1.0 / (near - far);
    [
        [f / aspect, 0.0, 0.0, 0.0],
        [0.0, f, 0.0, 0.0],
        [0.0, 0.0, (far + near) * nf, -1.0],
        [0.0, 0.0, 2.0 * far * near * nf, 0.0],
    ]
}

fn mul(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut out = [[0.0; 4]; 4];
    for column in 0..4 {
        for row in 0..4 {
            out[column][row] = a[0][row] * b[column][0] + a[1][row] * b[column][1] + a[2][row] * b[column][2] + a[3][row] * b[column][3];
        }
    }
    out
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(v: [f32; 3]) -> [f32; 3] {
    let len = dot(v, v).sqrt().max(0.0001);
    [v[0] / len, v[1] / len, v[2] / len]
}

const BOX: [Vertex; 36] = box_triangles();

const fn box_triangles() -> [Vertex; 36] {
    const P: [[f32; 3]; 8] = [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
    ];
    const IDX: [usize; 36] = [
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4,
    ];
    let mut out = [Vertex { pos: [0.0; 3] }; 36];
    let mut i = 0;
    while i < 36 {
        out[i] = Vertex { pos: P[IDX[i]] };
        i += 1;
    }
    out
}

impl Gpu {
    fn new(window: Arc<Window>) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let surface = instance.create_surface(window.clone()).map_err(|err| err.to_string())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .ok_or("no graphics adapter")?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default(), None))
            .map_err(|err| err.to_string())?;
        let size = window.inner_size();
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| format.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("scene"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniforms"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("uniforms"),
            layout: &bind_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene"),
            bind_group_layouts: &[&bind_layout],
            push_constant_ranges: &[],
        });
        let box_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("boxes"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_box",
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x3],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Instance>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &wgpu::vertex_attr_array![1 => Float32x3, 2 => Float32, 3 => Float32x3, 4 => Float32x4],
                    },
                ],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let line_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("lines"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_line",
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_line",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let box_vb = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("box"),
            size: std::mem::size_of_val(&BOX) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&box_vb, 0, bytemuck::cast_slice(&BOX));
        let instance_cap = 64;
        let instance_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("players"),
            size: (instance_cap * std::mem::size_of::<Instance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let line_cap = 4096;
        let line_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lines"),
            size: (line_cap * std::mem::size_of::<Vertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let egui = egui_winit::State::new(
            egui::Context::default(),
            egui::ViewportId::ROOT,
            &window,
            Some(window.scale_factor() as f32),
            None,
            None,
        );
        let egui_renderer = egui_wgpu::Renderer::new(&device, format, None, 1, false);
        Ok(Self {
            surface,
            device,
            queue,
            config,
            uniform_buf,
            uniform_bind,
            box_pipeline,
            line_pipeline,
            box_vb,
            instance_buf,
            instance_cap,
            line_buf,
            line_cap,
            egui,
            egui_renderer,
        })
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    fn write_camera(&self, uniforms: Uniforms) {
        self.queue.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&uniforms));
    }

    fn upload_scene(&mut self, players: &[Instance], lines: &[Vertex]) {
        if players.len() > self.instance_cap {
            self.instance_cap = players.len().next_power_of_two();
            self.instance_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("players"),
                size: (self.instance_cap * std::mem::size_of::<Instance>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if !players.is_empty() {
            self.queue.write_buffer(&self.instance_buf, 0, bytemuck::cast_slice(players));
        }
        let lines = if lines.len() > self.line_cap { &lines[..self.line_cap] } else { lines };
        if !lines.is_empty() {
            self.queue.write_buffer(&self.line_buf, 0, bytemuck::cast_slice(lines));
        }
    }
}

const SHADER: &str = r#"
struct Uniforms {
    view_proj: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_box(
    @location(0) corner: vec3<f32>,
    @location(1) pos: vec3<f32>,
    @location(2) yaw: f32,
    @location(3) size: vec3<f32>,
    @location(4) color: vec4<f32>,
) -> VsOut {
    let c = cos(yaw);
    let s = sin(yaw);
    let scaled = corner * size;
    let rotated = vec3<f32>(scaled.x * c - scaled.z * s, scaled.y, scaled.x * s + scaled.z * c);
    var out: VsOut;
    out.clip = u.view_proj * vec4<f32>(rotated + pos, 1.0);
    out.color = color;
    return out;
}

@vertex
fn vs_line(@location(0) pos: vec3<f32>) -> VsOut {
    var out: VsOut;
    out.clip = u.view_proj * vec4<f32>(pos, 1.0);
    out.color = vec4<f32>(0.95, 0.85, 0.35, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> { return in.color; }

@fragment
fn fs_line(in: VsOut) -> @location(0) vec4<f32> { return in.color; }
"#;
