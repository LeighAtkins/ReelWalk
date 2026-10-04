from apps.api.app.main import app, resolve_upload_type


def test_task_01_routes_are_registered():
    paths = {route.path for route in app.routes}

    assert "/listings" in paths
    assert "/listings/{listing_id}/upload" in paths
    assert "/listings/{listing_id}/jobs/last" in paths


def test_upload_type_resolution_preserves_image_and_video_extensions():
    assert resolve_upload_type("video/mp4", "walk.mp4") == ("video/mp4", "mp4")
    assert resolve_upload_type("image/jpeg", "pano.jpg") == ("image/jpeg", "jpg")
    assert resolve_upload_type("image/png", "pano.png") == ("image/png", "png")
    assert resolve_upload_type("video/quicktime", "walk.mov") == ("video/quicktime", "mov")


def test_upload_type_resolution_falls_back_to_filename_for_octet_stream():
    assert resolve_upload_type("application/octet-stream", "pano.JPEG") == ("image/jpeg", "jpeg")
    assert resolve_upload_type("application/octet-stream", "walk.mp4") == ("video/mp4", "mp4")
    assert resolve_upload_type("application/octet-stream", "mystery.bin") is None
    assert resolve_upload_type("text/plain", "notes.txt") is None
