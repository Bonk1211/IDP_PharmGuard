import cv2
from ultralytics import YOLO

# Load the YOLO model
model = YOLO('spotter_model.pt')

# Open the webcam (Camera index 2 as in original script)
cap = cv2.VideoCapture(2)

print("Starting webcam... Press 'q' to quit.")

while cap.isOpened():
    success, frame = cap.read()

    if success:
        results = model(frame, verbose=False)
        annotated_frame = results[0].plot()

        cv2.imshow("Pills Detection Live", annotated_frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
    else:
        break

cap.release()
cv2.destroyAllWindows()
