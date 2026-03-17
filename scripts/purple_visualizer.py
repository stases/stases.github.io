import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter


BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
WHITE_SOFT = (250, 246, 251)
BLUE_DEEP = (6, 18, 212)
BLUE_ELECTRIC = (18, 70, 255)
VIOLET = (150, 86, 255)
MAGENTA = (250, 168, 242)
PINK_LIGHT = (255, 224, 246)


def lerp(start, end, t):
    return start + (end - start) * t


def lerp_color(start, end, t):
    return tuple(int(round(lerp(a, b, t))) for a, b in zip(start, end))


def sample_stops(stops, t):
    if t <= stops[0][0]:
        return stops[0][1]

    for (start_pos, start_color), (end_pos, end_color) in zip(stops, stops[1:]):
        if t <= end_pos:
            local_t = 0 if end_pos == start_pos else (t - start_pos) / (end_pos - start_pos)
            return lerp_color(start_color, end_color, local_t)

    return stops[-1][1]


def scale_box(width, height, left, top, right, bottom):
    return (
        int(round(width * left)),
        int(round(height * top)),
        int(round(width * right)),
        int(round(height * bottom)),
    )


def make_gradient(size, stops, axis="vertical"):
    width, height = size
    gradient = Image.new("RGB", size, BLACK)
    draw = ImageDraw.Draw(gradient)

    span = height if axis == "vertical" else width
    span = max(span, 1)

    for index in range(span):
        t = 0 if span == 1 else index / (span - 1)
        color = sample_stops(stops, t)
        if axis == "vertical":
            draw.line((0, index, width, index), fill=color)
        else:
            draw.line((index, 0, index, height), fill=color)

    return gradient


def make_shape_mask(size, radius=0):
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)

    if radius > 0:
        draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=255)
    else:
        draw.rectangle((0, 0, width - 1, height - 1), fill=255)

    return mask


def screen_with_opacity(base, overlay, opacity=1.0):
    if opacity < 1.0:
        overlay = Image.blend(Image.new("RGB", base.size, BLACK), overlay, opacity)
    return ImageChops.screen(base, overlay)


def place_screen_layer(scene, layer, position, opacity=1.0, blur_radius=0):
    overlay = Image.new("RGB", scene.size, BLACK)
    overlay.paste(layer, position)

    if blur_radius > 0:
        overlay = overlay.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    return screen_with_opacity(scene, overlay, opacity)


def make_grain_map(size, sigma=18, contrast=3.0, blur_radius=0):
    noise = Image.effect_noise(size, sigma).convert("L")
    if blur_radius > 0:
        noise = noise.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    def boost(value):
        shifted = 128 + ((value - 128) * contrast)
        return max(0, min(255, int(shifted)))

    return noise.point(boost)


def apply_film_grain(image, amount=0.22, sigma=18, contrast=3.0, blur_radius=0):
    grain = make_grain_map(image.size, sigma=sigma, contrast=contrast, blur_radius=blur_radius)
    grain_rgb = Image.merge("RGB", (grain, grain, grain))
    overlaid = ImageChops.overlay(image, grain_rgb)
    softened = ImageChops.soft_light(image, grain_rgb)
    grained = Image.blend(overlaid, softened, 0.22)
    return Image.blend(image, grained, amount)


def make_blob(size, outer_color, mid_color, inner_color, center=(0.5, 0.5), span=(1.0, 1.0), blur_radius=None, steps=48):
    width, height = size
    blob = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(blob, "RGBA")

    max_width = width * span[0]
    max_height = height * span[1]
    center_x = width * center[0]
    center_y = height * center[1]
    stops = [(0.0, outer_color), (0.6, mid_color), (1.0, inner_color)]

    for index in range(steps):
        t = 0 if steps == 1 else index / (steps - 1)
        scale = 1.0 - (t * 0.9)
        ellipse_width = max_width * scale
        ellipse_height = max_height * scale
        color = sample_stops(stops, t)
        alpha = int(16 + ((t ** 1.6) * 118))

        box = (
            center_x - (ellipse_width / 2),
            center_y - (ellipse_height / 2),
            center_x + (ellipse_width / 2),
            center_y + (ellipse_height / 2),
        )
        draw.ellipse(box, fill=color + (alpha,))

    if blur_radius is None:
        blur_radius = max(8, int(min(width, height) * 0.045))

    blob = blob.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return Image.alpha_composite(Image.new("RGBA", size, (0, 0, 0, 255)), blob).convert("RGB")


def add_rect_panel(
    scene,
    box,
    stops,
    axis="vertical",
    radius=0,
    fill_opacity=1.0,
    glow_blur=48,
    glow_opacity=0.55,
    grain_amount=0.14,
    accents=None,
):
    width = max(1, box[2] - box[0])
    height = max(1, box[3] - box[1])

    fill = make_gradient((width, height), stops, axis=axis)

    for accent in accents or []:
        blob = make_blob(
            (width, height),
            accent.get("outer", BLUE_ELECTRIC),
            accent.get("mid", VIOLET),
            accent.get("inner", MAGENTA),
            center=accent.get("center", (0.5, 0.5)),
            span=accent.get("span", (0.8, 0.8)),
            blur_radius=accent.get("blur_radius"),
        )
        blob = Image.blend(Image.new("RGB", (width, height), BLACK), blob, accent.get("opacity", 0.7))
        fill = ImageChops.screen(fill, blob)

    if grain_amount > 0:
        fill = apply_film_grain(
            fill,
            amount=grain_amount,
            sigma=18,
            contrast=2.9,
            blur_radius=0,
        )

    local = Image.new("RGB", (width, height), BLACK)
    local.paste(fill, (0, 0), make_shape_mask((width, height), radius=radius))

    scene = place_screen_layer(scene, local, box[:2], opacity=fill_opacity)
    if glow_blur > 0 and glow_opacity > 0:
        scene = place_screen_layer(scene, local, box[:2], opacity=glow_opacity, blur_radius=glow_blur)
        scene = place_screen_layer(
            scene,
            local,
            box[:2],
            opacity=min(0.18, glow_opacity * 0.48),
            blur_radius=max(glow_blur * 2, int(min(width, height) * 0.22)),
        )

    return scene


def add_blob_cluster(
    scene,
    box,
    outer_color,
    mid_color,
    inner_color,
    center=(0.5, 0.5),
    span=(1.0, 1.0),
    fill_opacity=1.0,
    glow_blur=24,
    glow_opacity=0.45,
    grain_amount=0.14,
    overscan=0.6,
):
    width = max(1, box[2] - box[0])
    height = max(1, box[3] - box[1])
    pad_x = max(24, int(width * overscan))
    pad_y = max(24, int(height * overscan))
    expanded_size = (width + (pad_x * 2), height + (pad_y * 2))
    expanded_center = (
        (pad_x + (width * center[0])) / expanded_size[0],
        (pad_y + (height * center[1])) / expanded_size[1],
    )
    expanded_span = (
        (width * span[0]) / expanded_size[0],
        (height * span[1]) / expanded_size[1],
    )

    blob = make_blob(
        expanded_size,
        outer_color,
        mid_color,
        inner_color,
        center=expanded_center,
        span=expanded_span,
        blur_radius=max(10, int(min(width, height) * 0.06)),
        steps=56,
    )

    if grain_amount > 0:
        blob = apply_film_grain(
            blob,
            amount=grain_amount,
            sigma=18,
            contrast=3.0,
            blur_radius=0,
        )

    blob_position = (box[0] - pad_x, box[1] - pad_y)
    scene = place_screen_layer(scene, blob, blob_position, opacity=fill_opacity)
    if glow_blur > 0 and glow_opacity > 0:
        scene = place_screen_layer(scene, blob, blob_position, opacity=glow_opacity, blur_radius=glow_blur)
        scene = place_screen_layer(
            scene,
            blob,
            blob_position,
            opacity=min(0.2, glow_opacity * 0.58),
            blur_radius=max(glow_blur * 2, int(min(width, height) * 0.32)),
        )

    return scene


def draw_glow_line(scene, points, fill, width=2, glow_blur=4, glow_opacity=0.22):
    overlay = Image.new("RGB", scene.size, BLACK)
    draw = ImageDraw.Draw(overlay)
    draw.line(points, fill=fill, width=width)
    scene = screen_with_opacity(scene, overlay.filter(ImageFilter.GaussianBlur(radius=glow_blur)), glow_opacity)
    ImageDraw.Draw(scene).line(points, fill=fill, width=width)
    return scene


def draw_glow_rounded_outline(scene, box, radius, outline, width=3, glow_blur=6, glow_opacity=0.2):
    overlay = Image.new("RGB", scene.size, BLACK)
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle(box, radius=radius, outline=outline, width=width)
    scene = screen_with_opacity(scene, overlay.filter(ImageFilter.GaussianBlur(radius=glow_blur)), glow_opacity)
    ImageDraw.Draw(scene).rounded_rectangle(box, radius=radius, outline=outline, width=width)
    return scene


def generate_generative_art_scene(width, height, base_color=BLACK, grain_intensity=0.26):
    scene = Image.new("RGB", (width, height), base_color)

    line_color = (242, 236, 245)
    outline_width = max(3, width // 640)
    line_width = max(2, width // 760)
    card_box = scale_box(width, height, 0.275, 0.41, 0.725, 0.60)
    card_radius = max(30, height // 26)

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.11, 0.11, 0.34, 0.405),
        stops=[(0.0, BLUE_DEEP), (0.48, BLUE_ELECTRIC), (1.0, MAGENTA)],
        axis="vertical",
        fill_opacity=0.9,
        glow_blur=max(26, width // 40),
        glow_opacity=0.24,
        grain_amount=grain_intensity * 1.1,
        accents=[
            {"center": (0.34, 0.22), "span": (0.72, 0.56), "opacity": 0.42, "inner": VIOLET},
            {"center": (0.78, 0.72), "span": (0.55, 0.82), "opacity": 0.84, "inner": PINK_LIGHT},
        ],
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.18, 0.365, 0.305, 0.635),
        stops=[(0.0, BLUE_DEEP), (0.65, BLUE_ELECTRIC), (1.0, VIOLET)],
        axis="vertical",
        fill_opacity=0.82,
        glow_blur=max(18, width // 52),
        glow_opacity=0.26,
        grain_amount=grain_intensity * 0.95,
        accents=[
            {"center": (0.58, 0.85), "span": (0.78, 0.78), "opacity": 0.48, "inner": MAGENTA},
        ],
    )

    scene = add_blob_cluster(
        scene,
        scale_box(width, height, 0.095, 0.56, 0.37, 0.87),
        BLUE_ELECTRIC,
        VIOLET,
        WHITE_SOFT,
        center=(0.46, 0.58),
        span=(0.94, 0.98),
        fill_opacity=0.98,
        glow_blur=max(22, width // 54),
        glow_opacity=0.34,
        grain_amount=grain_intensity,
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.455, 0.29, 0.585, 0.49),
        stops=[(0.0, BLUE_ELECTRIC), (0.6, VIOLET), (1.0, MAGENTA)],
        axis="vertical",
        glow_blur=max(18, width // 54),
        glow_opacity=0.18,
        fill_opacity=0.7,
        grain_amount=grain_intensity * 0.75,
        accents=[
            {"center": (0.65, 0.72), "span": (0.7, 0.75), "opacity": 0.82, "inner": PINK_LIGHT},
        ],
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.565, 0.255, 0.665, 0.59),
        stops=[(0.0, BLUE_ELECTRIC), (0.62, VIOLET), (1.0, PINK_LIGHT)],
        axis="vertical",
        glow_blur=max(26, width // 42),
        glow_opacity=0.22,
        fill_opacity=0.68,
        grain_amount=grain_intensity * 0.7,
        accents=[
            {"center": (0.34, 0.7), "span": (0.7, 0.85), "opacity": 0.64, "inner": WHITE_SOFT},
        ],
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.595, 0.18, 0.715, 0.35),
        stops=[(0.0, MAGENTA), (0.55, PINK_LIGHT), (1.0, WHITE_SOFT)],
        axis="vertical",
        fill_opacity=0.94,
        glow_blur=max(14, width // 68),
        glow_opacity=0.12,
        grain_amount=grain_intensity * 0.55,
        accents=[
            {"center": (0.28, 0.9), "span": (0.6, 0.55), "opacity": 0.22, "inner": WHITE},
        ],
    )

    scene = add_rect_panel(
        scene,
        card_box,
        stops=[(0.0, BLUE_DEEP), (0.45, VIOLET), (1.0, MAGENTA)],
        axis="horizontal",
        radius=card_radius,
        fill_opacity=0.05,
        glow_blur=max(30, width // 34),
        glow_opacity=0.18,
        grain_amount=grain_intensity * 0.45,
        accents=[
            {"center": (0.3, 0.34), "span": (0.48, 0.88), "opacity": 0.5, "inner": PINK_LIGHT},
            {"center": (0.78, 0.62), "span": (0.44, 1.02), "opacity": 0.76, "inner": WHITE_SOFT},
        ],
    )

    scene = add_blob_cluster(
        scene,
        scale_box(width, height, 0.445, 0.44, 0.705, 0.95),
        BLUE_ELECTRIC,
        MAGENTA,
        WHITE_SOFT,
        center=(0.52, 0.4),
        span=(0.84, 1.02),
        fill_opacity=0.96,
        glow_blur=max(22, width // 50),
        glow_opacity=0.34,
        grain_amount=grain_intensity,
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.555, 0.735, 0.67, 0.965),
        stops=[(0.0, MAGENTA), (0.5, PINK_LIGHT), (1.0, BLUE_ELECTRIC)],
        axis="vertical",
        glow_blur=max(18, width // 58),
        glow_opacity=0.1,
        fill_opacity=0.46,
        grain_amount=grain_intensity * 0.6,
    )

    scene = add_blob_cluster(
        scene,
        scale_box(width, height, 0.78, 0.53, 0.92, 0.685),
        BLUE_ELECTRIC,
        VIOLET,
        PINK_LIGHT,
        center=(0.48, 0.56),
        span=(0.82, 1.0),
        fill_opacity=0.78,
        glow_blur=max(14, width // 74),
        glow_opacity=0.12,
        grain_amount=grain_intensity * 0.75,
    )

    scene = screen_with_opacity(
        scene,
        scene.filter(ImageFilter.GaussianBlur(radius=max(6, width // 260))),
        opacity=0.045,
    )

    crop_draw = ImageDraw.Draw(scene)
    crop_draw.rectangle(scale_box(width, height, 0.755, 0.60, 0.93, 0.78), fill=BLACK)
    scene = Image.blend(scene, Image.new("RGB", scene.size, BLACK), 0.055)

    scene = draw_glow_line(
        scene,
        (card_box[2], int(height * 0.475), int(width * 0.89), int(height * 0.475)),
        fill=line_color,
        width=line_width,
        glow_blur=3,
        glow_opacity=0.16,
    )
    scene = draw_glow_rounded_outline(
        scene,
        card_box,
        radius=card_radius,
        outline=line_color,
        width=outline_width,
        glow_blur=6,
        glow_opacity=0.18,
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.32, 0.79, 0.40, 0.895),
        stops=[(0.0, MAGENTA), (0.56, PINK_LIGHT), (1.0, BLUE_ELECTRIC)],
        axis="vertical",
        glow_blur=max(10, width // 84),
        glow_opacity=0.14,
        fill_opacity=0.82,
        grain_amount=grain_intensity * 0.6,
    )

    scene = add_rect_panel(
        scene,
        scale_box(width, height, 0.635, 0.755, 0.745, 0.865),
        stops=[(0.0, PINK_LIGHT), (0.65, WHITE_SOFT), (1.0, MAGENTA)],
        axis="horizontal",
        glow_blur=max(10, width // 84),
        glow_opacity=0.14,
        fill_opacity=0.9,
        grain_amount=grain_intensity * 0.5,
    )

    luminance_mask = scene.convert("L").filter(ImageFilter.GaussianBlur(radius=1.6))
    luminance_mask = Image.blend(Image.new("L", scene.size, 0), luminance_mask, 0.82)
    final_grain = apply_film_grain(
        scene,
        amount=min(0.5, grain_intensity * 1.9),
        sigma=22,
        contrast=3.55,
        blur_radius=0,
    )
    scene = Image.composite(final_grain, scene, luminance_mask)

    return scene


if __name__ == "__main__":
    width, height = 1920, 1080

    try:
        print(f"Generating generative art visualization ({width}x{height})...")
        generated_image = generate_generative_art_scene(width, height, grain_intensity=0.24)

        filename = "generated_visualization.png"
        generated_image.save(filename)
        print(f"Successfully generated visualization and saved as: {filename}")

        if sys.platform.startswith("linux"):
            import subprocess

            subprocess.call(["xdg-open", filename])
        elif sys.platform.startswith("darwin"):
            import subprocess

            subprocess.call(["open", filename])
        elif sys.platform.startswith("win"):
            import os

            os.startfile(filename)
        else:
            print("Visualization generated. Please open 'generated_visualization.png' to view it.")

    except ImportError:
        print("Error: Required library (pillow) is not installed.")
        print("Please install it using: pip install pillow")
    except Exception as error:
        print(f"An unexpected error occurred: {error}")
