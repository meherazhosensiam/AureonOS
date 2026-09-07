import QtQuick 2.0
import QtQuick.Controls 2.0

Rectangle {
    id: root
    width: 800
    height: 500
    color: "#0d0d0d"

    // Custom properties for slide control
    property int currentSlide: 0
    property int totalSlides: 4

    // Helper for unique animations
    SequentialAnimation {
        id: slideTransition
        NumberAnimation { target: slideImage; property: "opacity"; to: 0; duration: 300; easing.type: Easing.InOutQuad }
        PropertyAction { target: slideImage; property: "source"; value: getSource(currentSlide) }
        NumberAnimation { target: slideImage; property: "opacity"; to: 1; duration: 500; easing.type: Easing.OutBack }
    }

    function getSource(index) {
        switch(index) {
            case 0: return "welcome.png";
            case 1: return "applications.png";
            case 2: return "desktop.png";
            case 3: return "testdisk.img";
            default: return "welcome.png";
        }
    }

    // Main layout container
    Item {
        anchors.fill: parent
        anchors.margins: 40

        // Header
        Column {
            id: header
            anchors.top: parent.top
            anchors.left: parent.left
            spacing: 10

            Image {
                source: "logo.png"
                width: 64
                height: 64
                fillMode: Image.PreserveAspectFit
            }

            Text {
                text: "AUREON OS"
                color: "#e62e2e"
                font.pixelSize: 28
                font.bold: true
            }
        }

        // Slideshow display area
        Rectangle {
            id: displayArea
            anchors.top: header.bottom
            anchors.topMargin: 30
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 20
            color: "#1a1a1a"
            radius: 8
            clip: true

            Image {
                id: slideImage
                anchors.fill: parent
                anchors.margins: 20
                fillMode: Image.PreserveAspectFit
                source: "welcome.png"
            }

            // Overlay for unique visual flair per slide
            Rectangle {
                anchors.fill: parent
                color: "transparent"
                border.color: "#33ffffff"
                border.width: 1
                radius: 8
            }
        }
    }

    // Automatically cycle slides with unique timing/logic
    Timer {
        interval: 5000
        running: true
        repeat: true
        onTriggered: {
            currentSlide = (currentSlide + 1) % totalSlides
            slideTransition.restart()
        }
    }
}
